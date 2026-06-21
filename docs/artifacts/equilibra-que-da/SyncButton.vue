<template>
  <div :class="{ 'w-100': block }">
    <v-tooltip 
      text="Sincronizar agora" 
      location="bottom"
      color="grey-darken-4"
      :disabled="block" 
    >
      <template #activator="{ props: tooltipProps }">
        <v-btn
          id="nav-sync-button"
          v-bind="tooltipProps"
          :color="block ? 'primary' : undefined"
          :variant="block ? 'elevated' : 'text'"
          :icon="!block"
          :block="block"
          :loading="syncState.isSyncing"
          :prepend-icon="block ? mdiCloudSync : undefined"
          @click="handleSync"
        >
          <v-icon v-if="!block" :icon="mdiCloudSync" />
          
          <template v-if="block">
            Sincronizar Agora
          </template>
        </v-btn>
      </template>
      <span class="text-white">Sincronizar agora</span>
    </v-tooltip>

    <v-snackbar
      v-model="showSuccess"
      color="success"
      :timeout="3000"
      location="bottom"
    >
      Sincronização concluída com sucesso!
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { mdiCloudSync } from '@mdi/js'

// Prop 'block' controla se ele é um ícone (false) ou um botão largo com texto (true)
defineProps({
  block: {
    type: Boolean,
    default: false
  }
})

const store = useStudyStore()
const { syncState, downloadAndMerge, uploadData } = useSync()

const showSuccess = ref(false)

async function handleSync() {
  const merged = await downloadAndMerge({
    sessions: store.sessions,
    goal: store.goal
  })
  
  if (merged) {
    store.sessions = merged.sessions
    store.goal = merged.goal
  }
  
  if (!syncState.error && !syncState.hasConflict) {
    await uploadData({
      sessions: store.sessions,
      goal: store.goal
    })
  }

  if (!syncState.error && !syncState.hasConflict) {
    showSuccess.value = true
  }
}
</script>