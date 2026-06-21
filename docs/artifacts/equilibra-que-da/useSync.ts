import { LocalStorageSchema, type LocalStorageData, type Session } from '~/types'

// ─── Google OAuth / Drive constants ──────────────────────────────────────────
const CLIENT_ID = '445002403787-itd0g6pr510ekdiggg70ibfmefurbka8.apps.googleusercontent.com'
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const BACKUP_FILENAME = 'backup.json'
const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'
const TOKEN_INFO_API = 'https://www.googleapis.com/oauth2/v3/tokeninfo'

// ─── Storage keys ─────────────────────────────────────────────────────────────
// sessionStorage keys are cleared automatically when the tab closes, making it
// the right scope for OAuth access tokens in an SPA.
const SYNC_AUTO_KEY = 'equilibra-sync-auto'       // localStorage  (preference)
const SYNC_LAST_KEY = 'equilibra-sync-last'       // localStorage  (last sync timestamp)
const SYNC_TOKEN_KEY = 'equilibra-gd-token'        // sessionStorage (token)
const SYNC_EXPIRES_KEY = 'equilibra-gd-expires'      // sessionStorage (expiry epoch ms)
const SYNC_EMAIL_KEY = 'equilibra-gd-email'        // sessionStorage (display email)

// ─── Module-level singletons ──────────────────────────────────────────────────
// One token client per page-lifecycle; never recreated to avoid duplicate
// Google Identity Services (GIS) script injections.
let _tokenClient: any = null
let _accessToken: string | null = null
let _gisInitPromise: Promise<void> | null = null
let _connectTimeoutId: ReturnType<typeof setTimeout> | null = null

// Cached Drive file ID — avoids a list-files call on every upload.
let _backupFileId: string | null = null

// ─── Global reactive state ────────────────────────────────────────────────────
const _syncState = reactive({
    isConnected: false,
    isConnecting: false,
    isSyncing: false,
    lastSyncAt: null as string | null,
    provider: null as string | null,
    userAddress: null as string | null,
    error: null as string | null,
    hasConflict: false,
    pendingConflict: null as LocalStorageData | null,
})

// ─── Auto-sync preference ─────────────────────────────────────────────────────
const _autoSyncInner = ref(false)

const autoSync = computed({
    get: () => _autoSyncInner.value,
    set: (val: boolean) => {
        _autoSyncInner.value = val
        if (import.meta.client) {
            localStorage.setItem(SYNC_AUTO_KEY, val ? 'true' : 'false')
        }
    },
})

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Cancel the safety timeout and clear the isConnecting flag. */
function _clearConnecting(): void {
    if (_connectTimeoutId) {
        clearTimeout(_connectTimeoutId)
        _connectTimeoutId = null
    }
    _syncState.isConnecting = false
}

/**
 * Called when the Drive API returns a 401. Clears the persisted token and
 * marks the session as disconnected so the user sees the connect form again.
 */
function _handleAuthExpiry(): void {
    _accessToken = null
    _backupFileId = null
    sessionStorage.removeItem(SYNC_TOKEN_KEY)
    sessionStorage.removeItem(SYNC_EXPIRES_KEY)
    _syncState.isConnected = false
    _syncState.provider = null
    _syncState.error = 'Sessão expirada. Por favor, conecte-se novamente.'
}

/**
 * Injects the Google Identity Services script tag once.
 * Resolves immediately if it has already been loaded.
 */
function _loadGISScript(): Promise<void> {
    if ((window as any).google?.accounts?.oauth2) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = 'https://accounts.google.com/gsi/client'
        script.async = true
        script.onload = () => resolve()
        script.onerror = () => reject(new Error('Falha ao carregar o serviço de autenticação do Google®.'))
        document.head.appendChild(script)
    })
}

/**
 * Attempt to restore a previous session from sessionStorage.
 * Only restores if the stored token has not yet expired.
 */
function _restoreSession(): void {
    const token = sessionStorage.getItem(SYNC_TOKEN_KEY)
    const expiresAt = parseInt(sessionStorage.getItem(SYNC_EXPIRES_KEY) ?? '0', 10)
    const email = sessionStorage.getItem(SYNC_EMAIL_KEY)
    const lastSync = localStorage.getItem(SYNC_LAST_KEY)

    // Add a 60-second buffer so we don't restore a token that is about to expire
    if (token && Date.now() < expiresAt - 60_000) {
        _accessToken = token
        _syncState.isConnected = true
        _syncState.provider = 'googledrive'
        _syncState.userAddress = email
        if (lastSync) _syncState.lastSyncAt = lastSync
    }
}

/**
 * Finds the backup file ID in appDataFolder.
 * Result is cached in _backupFileId to avoid a list call on every upload.
 */
async function _findBackupFileId(): Promise<string | null> {
    if (_backupFileId) return _backupFileId
    if (!_accessToken) return null

    const params = new URLSearchParams({
        spaces: 'appDataFolder',
        fields: 'files(id)',
        q: `name='${BACKUP_FILENAME}'`,
    })
    const res = await fetch(`${DRIVE_FILES_API}?${params}`, {
        headers: { Authorization: `Bearer ${_accessToken}` },
    })

    if (res.status === 401) { _handleAuthExpiry(); return null }
    if (!res.ok) throw new Error(`Erro ${res.status} ao listar arquivos do Google Drive®.`)

    const data = await res.json()
    const id: string | undefined = data.files?.[0]?.id
    if (id) _backupFileId = id
    return id ?? null
}

// ─── Conflict detection ───────────────────────────────────────────────────────
// A conflict exists when the remote backup contains session IDs absent locally,
// meaning the user made changes on another device that were never pulled here.
function _detectConflict(local: LocalStorageData, remote: LocalStorageData): boolean {
    const localIds = new Set(local.sessions.map(s => s.id))
    return remote.sessions.some(s => !localIds.has(s.id))
}

// ─── Session merge ────────────────────────────────────────────────────────────
// localStorage is the source of truth. Sessions only in the remote are folded
// in; conflicts are resolved in favour of the local version.
function _mergeSessions(local: Session[], remote: Session[]): Session[] {
    const map = new Map<string, Session>()
    for (const s of remote) map.set(s.id, s)
    for (const s of local) map.set(s.id, s) // local wins
    return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date))
}

// ─── GIS initialization (idempotent) ─────────────────────────────────────────
async function _initGIS(): Promise<void> {
    if (!import.meta.client) return
    if (_gisInitPromise) return _gisInitPromise

    _autoSyncInner.value = localStorage.getItem(SYNC_AUTO_KEY) === 'true'

    _gisInitPromise = (async () => {
        await _loadGISScript()

        // Attempt to restore a session from a previous page visit within the tab.
        _restoreSession()

        _tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPE,

            // Called when the user approves the OAuth popup or when GIS silently
            // returns a new token (automatic token refresh without user interaction).
            callback: async (tokenResponse: any) => {
                _clearConnecting()

                if (tokenResponse.error) {
                    _syncState.error = tokenResponse.error_description
                        ?? 'Autorização recusada pelo Google®.'
                    return
                }

                _accessToken = tokenResponse.access_token
                const expiresIn: number = tokenResponse.expires_in ?? 3600
                const expiresAt = Date.now() + expiresIn * 1000

                sessionStorage.setItem(SYNC_TOKEN_KEY, _accessToken!)
                sessionStorage.setItem(SYNC_EXPIRES_KEY, String(expiresAt))

                // Retrieve the signed-in account's email address (best-effort).
                // The tokeninfo endpoint is a public Google API with no API key
                // requirement, so the token is the only credential needed.
                try {
                    const info = await fetch(`${TOKEN_INFO_API}?access_token=${_accessToken}`)
                    if (info.ok) {
                        const { email } = await info.json()
                        _syncState.userAddress = email ?? null
                        if (email) sessionStorage.setItem(SYNC_EMAIL_KEY, email)
                    }
                }
                catch { /* non-critical — display email is cosmetic */ }

                _syncState.isConnected = true
                _syncState.provider = 'googledrive'
                _syncState.error = null
            },

            // Fired when the popup is blocked, closed by the user, or encounters a
            // network-level error before the token is returned.
            error_callback: (err: any) => {
                _clearConnecting()
                const type: string = err?.type ?? ''
                if (type === 'popup_closed') {
                    _syncState.error = 'Janela de autenticação fechada. Tente novamente.'
                }
                else if (type === 'popup_failed_to_open') {
                    _syncState.error =
                        'Não foi possível abrir a janela do Google®. Permita popups para este site e tente novamente.'
                }
                else {
                    _syncState.error =
                        'Não foi possível conectar ao Google®. Verifique sua conexão e tente novamente.'
                }
            },
        })
    })()

    return _gisInitPromise
}

// ─── Public composable ────────────────────────────────────────────────────────
export function useSync() {
    /**
     * Bootstrap GIS and attempt to restore a previous session.
     * Called early in the plugin so auto-reconnect happens on every page load.
     */
    async function initRS(): Promise<void> {
        return _initGIS()
    }

    /**
     * Open the Google account-picker popup. `emailHint` pre-fills the email
     * field so returning users don't have to type it again.
     *
     * Safety timeout (15 s): if the GIS popup never fires the callback (e.g.
     * popup blocked by the browser before `error_callback` fires, or the user
     * leaves the popup open indefinitely), we reset the loading state and show
     * an actionable error message. The timer is unconditionally cancelled as
     * soon as either `callback` or `error_callback` fires.
     */
    async function connect(emailHint: string): Promise<void> {
        await _initGIS()
        if (!_tokenClient) return

        _syncState.isConnecting = true
        _syncState.error = null

        _connectTimeoutId = setTimeout(() => {
            _connectTimeoutId = null
            if (_syncState.isConnecting) {
                _syncState.isConnecting = false
                _syncState.error =
                    'Não foi possível conectar ao Google®. Verifique se os popups estão permitidos.'
            }
        }, 15_000)

        try {
            _tokenClient.requestAccessToken({
                hint: emailHint.trim() || undefined,
                // 'select_account' forces the account picker even for returning users,
                // giving them the chance to switch accounts.
                prompt: 'select_account',
            })
        }
        catch (err: any) {
            _clearConnecting()
            _syncState.error = err?.message ?? 'Erro ao iniciar autenticação com o Google.'
        }
    }

    /** Revoke the token, clear all session data and reset the UI state. */
    function disconnect(): void {
        if (_accessToken) {
            try {
                (window as any).google?.accounts?.oauth2?.revoke(_accessToken, () => { })
            }
            catch { /* ignore — token may already be invalid */ }
            _accessToken = null
        }
        _backupFileId = null
        sessionStorage.removeItem(SYNC_TOKEN_KEY)
        sessionStorage.removeItem(SYNC_EXPIRES_KEY)
        sessionStorage.removeItem(SYNC_EMAIL_KEY)
        _syncState.isConnected = false
        _syncState.provider = null
        _syncState.userAddress = null
        _syncState.error = null
    }

    /**
     * Upload `data` to the `appDataFolder` as `backup.json`.
     * Uses PATCH (media upload) when the file already exists, or a multipart
     * POST to create it on the first run. Falls back to re-create if the file
     * was deleted externally (404 on PATCH).
     */
    async function uploadData(data: LocalStorageData): Promise<void> {
        if (!import.meta.client || !_accessToken || !_syncState.isConnected) return

        try {
            _syncState.isSyncing = true

            const payload = JSON.stringify({
                sessions: data.sessions,
                goal: data.goal,
                exportedAt: new Date().toISOString(),
            })

            let fileId = await _findBackupFileId()

            // ── Update existing file ──
            if (fileId) {
                const res = await fetch(`${DRIVE_UPLOAD_API}/${fileId}?uploadType=media`, {
                    method: 'PATCH',
                    headers: {
                        Authorization: `Bearer ${_accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: payload,
                })

                if (res.status === 401) { _handleAuthExpiry(); return }

                // File was deleted on Drive externally — reset cache and re-create below.
                if (res.status === 404) {
                    _backupFileId = null
                    fileId = null
                }
                else if (!res.ok) {
                    throw new Error(`Erro ${res.status} ao atualizar o arquivo no Google Drive®.`)
                }
            }

            // ── Create new file (first upload or after external deletion) ──
            if (!fileId) {
                const boundary = `eq_${Date.now()}`
                const metadata = JSON.stringify({
                    name: BACKUP_FILENAME,
                    parents: ['appDataFolder'],
                })
                const body = [
                    `--${boundary}`,
                    'Content-Type: application/json; charset=UTF-8',
                    '',
                    metadata,
                    `--${boundary}`,
                    'Content-Type: application/json',
                    '',
                    payload,
                    `--${boundary}--`,
                ].join('\r\n')

                const res = await fetch(`${DRIVE_UPLOAD_API}?uploadType=multipart`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${_accessToken}`,
                        'Content-Type': `multipart/related; boundary=${boundary}`,
                    },
                    body,
                })

                if (res.status === 401) { _handleAuthExpiry(); return }
                if (!res.ok) throw new Error(`Erro ${res.status} ao criar o arquivo no Google Drive®.`)

                const created = await res.json()
                _backupFileId = created.id
            }

            _syncState.lastSyncAt = new Date().toISOString()
            localStorage.setItem(SYNC_LAST_KEY, _syncState.lastSyncAt)
            _syncState.error = null
        }
        catch (err: any) {
            _syncState.error = err?.message ?? 'Falha ao enviar dados para o Google Drive®.'
        }
        finally {
            _syncState.isSyncing = false
        }
    }

    /**
     * Download the remote `backup.json`, validate it with Zod and merge it
     * with `localData`. Returns the merged payload, or `null` if:
     * - no remote backup exists yet, or
     * - the remote data is invalid, or
     * - the connection is unavailable.
     *
     * The caller is responsible for writing the result to the Pinia store.
     */
    async function downloadAndMerge(localData: LocalStorageData): Promise<LocalStorageData | null> {
        if (!import.meta.client || !_accessToken || !_syncState.isConnected) return null

        try {
            _syncState.isSyncing = true

            const fileId = await _findBackupFileId()
            if (!fileId) return null   // No backup in Drive yet — not an error

            const res = await fetch(`${DRIVE_FILES_API}/${fileId}?alt=media`, {
                headers: { Authorization: `Bearer ${_accessToken}` },
            })

            if (res.status === 401) { _handleAuthExpiry(); return null }
            if (res.status === 404) { _backupFileId = null; return null }
            if (!res.ok) throw new Error(`Erro ${res.status} ao baixar dados do Google Drive®.`)

            const raw = await res.text()
            const remoteResult = LocalStorageSchema.safeParse(JSON.parse(raw))

            if (!remoteResult.success) {
                _syncState.error = 'Dados remotos inválidos ou incompatíveis com esta versão.'
                return null
            }

            if (_detectConflict(localData, remoteResult.data)) {
                _syncState.hasConflict = true
                _syncState.pendingConflict = remoteResult.data
                return null
            }

            const merged: LocalStorageData = {
                sessions: _mergeSessions(localData.sessions, remoteResult.data.sessions),
                goal: localData.goal, // local goal is always the source of truth
            }

            _syncState.lastSyncAt = new Date().toISOString()
            localStorage.setItem(SYNC_LAST_KEY, _syncState.lastSyncAt)
            _syncState.error = null
            return merged
        }
        catch (err: any) {
            _syncState.error = err?.message ?? 'Falha ao baixar dados do Google Drive®.'
            return null
        }
        finally {
            _syncState.isSyncing = false
        }
    }

    async function resolveKeepLocal(localData: LocalStorageData): Promise<void> {
        _syncState.hasConflict = false
        _syncState.pendingConflict = null
        await uploadData(localData)
    }

    function resolveRestoreRemote(): LocalStorageData | null {
        const remote = _syncState.pendingConflict
        _syncState.hasConflict = false
        _syncState.pendingConflict = null
        return remote
    }

    return {
        syncState: readonly(_syncState),
        autoSync,
        initRS,
        connect,
        disconnect,
        uploadData,
        downloadAndMerge,
        resolveKeepLocal,
        resolveRestoreRemote,
    }
}