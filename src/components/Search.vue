<template>
  <div class="column">
    <div class="col-auto">
      <div class="row items-center q-px-none q-gutter-md rounded-borders componentSearchBar">
        <q-input class="col" outlined :loading="searchState" type="search" autofocus :dense="false" clearable
          debounce="1000" :label="searchHint" :model-value="searchString" @update:model-value="onQChange">
          <template v-slot:append>
            <q-btn round flat @click="requestSearch" icon="search" />
          </template>
        </q-input>
        <q-input filled dense debounce="300" color="primary" type="number" style="max-width: 100px"
          v-model="numberOfSearchResults">
          <q-tooltip>Number of search results.</q-tooltip>
        </q-input>
        <q-btn v-if="showFilterButton" flat stretch icon="filter_alt" @click="toggleFilter">
          <q-tooltip>Toggle Filter Options</q-tooltip>
        </q-btn>
        <q-btn v-if="showGridButton" flat stretch dense :icon="usegrid ? 'view_list' : 'view_module'"
          @click="$emit('update:usegrid', !usegrid)" aria-label="Table">
          <q-tooltip>{{ usegrid ? 'Table Mode' : 'Grid Mode' }}</q-tooltip>
        </q-btn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps({
  searchState: {
    type: Boolean,
    default: false
  },
  searchHint: {
    type: String,
    default: 'Search...'
  },
  showFilterButton: {
    type: Boolean,
    default: false
  },
  showGridButton: {
    type: Boolean,
    default: false
  },
  usegrid: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['search', 'toggleFilter'])

const searchString = ref<string>('');
const numberOfSearchResults = ref<number>(5);

function onQChange(value: string) {
  searchString.value = value
  emit('search', value, Number(numberOfSearchResults.value));
};

const requestSearch = () => {
  emit('search', searchString.value, Number(numberOfSearchResults.value));
};

const toggleFilter = () => {
  emit('toggleFilter');
};
</script>