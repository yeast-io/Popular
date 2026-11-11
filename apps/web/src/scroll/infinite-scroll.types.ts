import type { Ref } from 'vue';

export interface InfiniteScrollOptions {
  target: Ref<HTMLElement | null>;
  enabled: () => boolean;
  load: () => void;
}
