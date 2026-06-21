#!/usr/bin/env bash
# =============================================================================
# Script de Release - Equilibra Que Dá!
# =============================================================================
#
# Uso:
#   ./scripts/release.sh [tipo] [--pre <label>] [--dry-run]
#
# Tipos (semver):
#   patch   - Correções de bugs (1.0.0 → 1.0.1)
#   minor   - Novas funcionalidades (1.0.0 → 1.1.0)
#   major   - Breaking changes (1.0.0 → 2.0.0)
#
# Opções:
#   --pre <label>   - Cria tag de pré-release (ex: --pre beta → v1.1.0-beta.1)
#   --dry-run       - Mostra o que seria feito sem executar
#
# =============================================================================

set -euo pipefail

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Variáveis
DRY_RUN=false
PRE_LABEL=""
BUMP_TYPE=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# =============================================================================
# Funções auxiliares
# =============================================================================

info()    { echo -e "${BLUE}ℹ${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
error()   { echo -e "${RED}✗${NC} $1"; exit 1; }
dry()     { echo -e "${CYAN}[dry-run]${NC} $1"; }

header() {
    echo ""
    echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
    echo -e "${BOLD}   $1${NC}"
    echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
    echo ""
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            patch|minor|major)
                BUMP_TYPE="$1"
                shift
                ;;
            --pre)
                shift
                PRE_LABEL="${1:-beta}"
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            -h|--help)
                head -25 "$0" | tail -22
                exit 0
                ;;
            *)
                error "Argumento desconhecido: $1. Use -h para ajuda."
                ;;
        esac
    done
}

# =============================================================================
# Validações
# =============================================================================

validate_environment() {
    cd "$PROJECT_DIR"

    if ! git rev-parse --is-inside-work-tree &>/dev/null; then
        error "Não é um repositório Git."
    fi

    if ! git diff --quiet HEAD 2>/dev/null; then
        error "Há alterações não commitadas. Faça commit ou stash antes de criar uma release."
    fi

    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

    if [[ -n "$PRE_LABEL" ]]; then
        info "Branch atual: ${BOLD}$CURRENT_BRANCH${NC} (pré-release)"
    else
        if [[ "$CURRENT_BRANCH" != "main" ]]; then
            error "Releases estáveis só podem ser criadas da branch ${BOLD}main${NC}. Branch atual: ${BOLD}$CURRENT_BRANCH${NC}\n   Use ${CYAN}--pre beta${NC} para criar uma pré-release desta branch."
        fi
        info "Branch atual: ${BOLD}$CURRENT_BRANCH${NC}"
    fi

    if ! git ls-remote --exit-code origin &>/dev/null; then
        warn "Remote 'origin' não está acessível ou você está offline. O push falhará no final."
    fi
}

# =============================================================================
# Versão
# =============================================================================

get_latest_stable_tag() {
    git tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1
}

get_latest_pre_tag() {
    local base_version="$1"
    local label="$2"
    git tag --list "v${base_version}-${label}.*" --sort=-v:refname | head -1
}

parse_version() {
    local tag="$1"
    local version="${tag#v}"
    version="${version%%-*}"

    IFS='.' read -r MAJOR MINOR PATCH <<< "$version"
    MAJOR="${MAJOR:-0}"
    MINOR="${MINOR:-0}"
    PATCH="${PATCH:-0}"
}

bump_version() {
    local type="$1"
    case "$type" in
        major)
            MAJOR=$((MAJOR + 1))
            MINOR=0
            PATCH=0
            ;;
        minor)
            MINOR=$((MINOR + 1))
            PATCH=0
            ;;
        patch)
            PATCH=$((PATCH + 1))
            ;;
    esac
}

calculate_new_version() {
    local latest_tag
    latest_tag=$(get_latest_stable_tag)

    if [[ -z "$latest_tag" ]]; then
        warn "Nenhuma tag encontrada. Usando v0.0.0 como base."
        MAJOR=0; MINOR=0; PATCH=0
    else
        info "Última tag estável: ${BOLD}$latest_tag${NC}"
        parse_version "$latest_tag"
    fi

    if [[ -z "$BUMP_TYPE" ]]; then
        echo ""
        echo -e "${BOLD}Tipo de release:${NC}"
        echo -e "  ${CYAN}1)${NC} patch  - Correções de bugs       (→ v${MAJOR}.${MINOR}.$((PATCH + 1)))"
        echo -e "  ${CYAN}2)${NC} minor  - Novas funcionalidades   (→ v${MAJOR}.$((MINOR + 1)).0)"
        echo -e "  ${CYAN}3)${NC} major  - Breaking changes        (→ v$((MAJOR + 1)).0.0)"
        echo ""
        read -rp "Escolha [1/2/3]: " choice
        case "$choice" in
            1) BUMP_TYPE="patch" ;;
            2) BUMP_TYPE="minor" ;;
            3) BUMP_TYPE="major" ;;
            *) error "Opção inválida." ;;
        esac
    fi

    bump_version "$BUMP_TYPE"
    NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

    if [[ -n "$PRE_LABEL" ]]; then
        local latest_pre
        latest_pre=$(get_latest_pre_tag "$NEW_VERSION" "$PRE_LABEL")

        if [[ -z "$latest_pre" ]]; then
            PRE_NUMBER=1
        else
            # Extrair o número da última pré-release
            PRE_NUMBER=$(echo "$latest_pre" | grep -oE '[0-9]+$')
            PRE_NUMBER=$((PRE_NUMBER + 1))
        fi

        NEW_TAG="v${NEW_VERSION}-${PRE_LABEL}.${PRE_NUMBER}"
    else
        NEW_TAG="v${NEW_VERSION}"
    fi

    success "Nova tag: ${BOLD}$NEW_TAG${NC}"
}

# =============================================================================
# Changelog e Dependências
# =============================================================================

check_changelog() {
    local changelog="$PROJECT_DIR/CHANGELOG.md"

    if [[ ! -f "$changelog" ]]; then
        warn "CHANGELOG.md não encontrado."
        return
    fi

    if grep -q "^## \[${NEW_VERSION}\]" "$changelog"; then
        info "CHANGELOG.md já documenta a versão [${NEW_VERSION}]."
        return
    fi

    local unreleased_content
    unreleased_content=$(sed -n '/^## \[Unreleased\]/,/^## \[/p' "$changelog" | tail -n +2 | head -n -1 | grep -v '^$' || true)

    if [[ -z "$unreleased_content" ]]; then
        warn "Seção [Unreleased] do CHANGELOG.md está vazia."
        if [[ -z "$PRE_LABEL" ]]; then
            read -rp "Continuar mesmo assim? [s/N]: " confirm
            [[ "$confirm" =~ ^[sS]$ ]] || exit 0
        fi
    fi
}

update_project_files() {
    local changelog="$PROJECT_DIR/CHANGELOG.md"
    local package_json="$PROJECT_DIR/package.json"
    local today
    today=$(date +%Y-%m-%d)

    if $DRY_RUN; then
        dry "Atualizaria versão no package.json para ${NEW_VERSION}"
        [[ -f "$changelog" ]] && dry "Atualizaria [Unreleased] no CHANGELOG.md"
        return
    fi

    # Atualiza package.json (usando node para maior compatibilidade se disponível, ou sed)
    if command -v node >/dev/null 2>&1; then
        node -e "const fs = require('fs'); const pkg = JSON.parse(fs.readFileSync('$package_json')); pkg.version = '${NEW_VERSION}'; fs.writeFileSync('$package_json', JSON.stringify(pkg, null, 2) + '\n');"
    else
        sed -i "s/\"version\": \".*\"/\"version\": \"${NEW_VERSION}\"/" "$package_json"
    fi

    # Atualiza CHANGELOG para releases estáveis
    if [[ -z "$PRE_LABEL" && -f "$changelog" ]]; then
        if ! grep -q "^## \[${NEW_VERSION}\]" "$changelog"; then
            sed -i "s/^## \[Unreleased\]/## [Unreleased]\n\n## [${NEW_VERSION}] - ${today}/" "$changelog"
            
            # Converte headers de inglês para português para a nova versão se ainda houver
            sed -i 's/### Added/### Adicionado/g' "$changelog"
            sed -i 's/### Changed/### Modificado/g' "$changelog"
            sed -i 's/### Fixed/### Corrigido/g' "$changelog"
            sed -i 's/### Removed/### Removido/g' "$changelog"
            sed -i 's/### Deprecated/### Obsoleto/g' "$changelog"
            sed -i 's/### Security/### Segurança/g' "$changelog"
            
            success "CHANGELOG.md atualizado (e traduzido)."
        fi
    fi
    
    success "Arquivos do projeto atualizados para v${NEW_VERSION}."
}

# =============================================================================
# Build / Testes
# =============================================================================

run_build_check() {
    info "Executando build de verificação (npm run generate)..."

    if $DRY_RUN; then
        dry "Executaria: npm run generate"
        return
    fi

    if npm run generate > /dev/null 2>&1; then
        success "Build concluído com sucesso."
    else
        error "Falha no build. Corrija os erros antes de criar a release."
    fi
}

# =============================================================================
# Git operations
# =============================================================================

create_tag() {
    local message
    message=$([[ -n "$PRE_LABEL" ]] && echo "Pré-release ${NEW_TAG}" || echo "Release ${NEW_TAG}")

    if $DRY_RUN; then
        dry "Git: add package.json e CHANGELOG.md"
        dry "Git: commit -m \"chore: release ${NEW_TAG}\""
        dry "Git: tag -a \"${NEW_TAG}\""
        return
    fi

    git add package.json
    [[ -f "$PROJECT_DIR/CHANGELOG.md" ]] && git add CHANGELOG.md
    
    git commit -m "chore: release ${NEW_TAG}" || info "Nenhuma mudança nos arquivos para commitar."
    git tag -a "$NEW_TAG" -m "$message"
    success "Tag ${BOLD}$NEW_TAG${NC} criada localmente."

    echo ""
    read -rp "Fazer push para origin? [S/n]: " push_confirm
    if [[ ! "$push_confirm" =~ ^[nN]$ ]]; then
        git push origin "$CURRENT_BRANCH" --tags
        success "Push realizado com sucesso."
    else
        warn "Push ignorado. Execute manualmente: git push origin $CURRENT_BRANCH --tags"
    fi
}

# =============================================================================
# Main
# =============================================================================

main() {
    parse_args "$@"
    header "$([[ "$DRY_RUN" == "true" ]] && echo "Release (Simulação)" || echo "Release")"

    validate_environment
    calculate_new_version
    check_changelog
    run_build_check
    update_project_files
    create_tag

    header "Sucesso!"
    echo -e "  Versão: ${BOLD}$NEW_TAG${NC}"
    echo -e "  Deploy: Disparado via GitHub Actions (se tag pushada)."
    echo ""
}

main "$@"