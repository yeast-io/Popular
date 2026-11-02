import type { usePageScroll } from './page-scroll.composable';

export type PageScrollController = ReturnType<typeof usePageScroll>;
export interface ScrollControlsProps {
  scroll: PageScrollController;
  enabled: boolean;
}
