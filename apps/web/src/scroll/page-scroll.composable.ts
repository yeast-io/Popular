import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

export function usePageScroll() {
  const positions = new Map<string, number>();
  let restoreFrame: number | undefined;
  let restoreRevision = 0;
  let disposed = false;
  const atTop = ref(true);
  const atBottom = ref(true);
  let scrollUpdateFrame: number | undefined;
  let contentObserver: MutationObserver | undefined;
  let pageScrollContainer: HTMLElement | null = null;
  let previousScrollRestoration: ScrollRestoration | undefined;
  onMounted(() => {
    previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    window.addEventListener('scroll', scheduleScrollControlsUpdate, { passive: true });
    pageScrollContainer = document.getElementById('app');
    pageScrollContainer?.addEventListener('scroll', scheduleScrollControlsUpdate, { passive: true });
    window.addEventListener('resize', scheduleScrollControlsUpdate);
    contentObserver = new MutationObserver(scheduleScrollControlsUpdate);
    contentObserver.observe(document.querySelector('#app') ?? document.body, { childList: true, subtree: true });
    scheduleScrollControlsUpdate();
  });
  onBeforeUnmount(() => {
    disposed = true;
    ++restoreRevision;
    window.removeEventListener('scroll', scheduleScrollControlsUpdate);
    pageScrollContainer?.removeEventListener('scroll', scheduleScrollControlsUpdate);
    window.removeEventListener('resize', scheduleScrollControlsUpdate);
    contentObserver?.disconnect();
    if (scrollUpdateFrame !== undefined) window.cancelAnimationFrame(scrollUpdateFrame);
    if (previousScrollRestoration) window.history.scrollRestoration = previousScrollRestoration;
    if (restoreFrame !== undefined) window.cancelAnimationFrame(restoreFrame);
  });

  function historyState(): Record<string, unknown> {
    return window.history.state && typeof window.history.state === 'object'
      ? (window.history.state as Record<string, unknown>)
      : {};
  }
  function activeScrollContainer() {
    const container = document.getElementById('app');
    return container && window.getComputedStyle(container).overflowY === 'auto' ? container : null;
  }

  function scrollPageTo(options: ScrollToOptions) {
    ++restoreRevision;
    if (restoreFrame !== undefined) {
      window.cancelAnimationFrame(restoreFrame);
      restoreFrame = undefined;
    }
    if (disposed) return;
    const container = activeScrollContainer();
    if (container) container.scrollTo(options);
    else window.scrollTo(options);
  }

  function rememberPosition(key: string) {
    positions.set(key, Math.max(0, activeScrollContainer()?.scrollTop ?? window.scrollY));
    window.history.replaceState({ ...historyState(), listPage: key, scrollY: positions.get(key) }, '');
  }

  function restorePosition(key: string) {
    const revision = ++restoreRevision;
    if (restoreFrame !== undefined) window.cancelAnimationFrame(restoreFrame);
    const state = historyState();
    const savedScrollY = state.listPage === key && typeof state.scrollY === 'number' && Number.isFinite(state.scrollY)
      ? Math.max(0, state.scrollY)
      : positions.get(key) ?? 0;
    positions.set(key, savedScrollY);
    void nextTick(() => {
      if (disposed || revision !== restoreRevision) return;
      restoreFrame = window.requestAnimationFrame(() => {
        restoreFrame = undefined;
        if (!disposed && revision === restoreRevision) scrollPageTo({ top: savedScrollY, behavior: 'auto' });
      });
    });
  }

  function scheduleScrollControlsUpdate() {
    if (scrollUpdateFrame !== undefined) return;
    scrollUpdateFrame = window.requestAnimationFrame(() => {
      scrollUpdateFrame = undefined;
      const container = activeScrollContainer();
      const maxScroll = Math.max(0, (container?.scrollHeight ?? document.documentElement.scrollHeight) - (container?.clientHeight ?? window.innerHeight));
      const scrollTop = container?.scrollTop ?? window.scrollY;
      atTop.value = scrollTop <= 8;
      atBottom.value = maxScroll <= 8 || scrollTop >= maxScroll - 8;
    });
  }

  function scrollToEdge(edge: 'top' | 'bottom') {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollPageTo({
      top: edge === 'top' ? 0 : (activeScrollContainer()?.scrollHeight ?? document.documentElement.scrollHeight),
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }

  return { atTop, atBottom, scrollPageTo, rememberPosition, restorePosition, scrollToEdge };
}
