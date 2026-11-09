import { back, getLogs, longPress, openURL, press, reload, screenshot, scroll, toggle, typeText } from './actions';
import { checkLayout } from './checks';
import { tree } from './inspect';

export type MethodFn = (params: unknown) => Promise<unknown>;

/** Protocol method name -> implementation. */
export const methods: Record<string, MethodFn> = {
  tree: (params) => tree(params),
  press: (params) => press(params),
  longPress: (params) => longPress(params),
  type: (params) => typeText(params),
  scroll: (params) => scroll(params),
  toggle: (params) => toggle(params),
  openURL: (params) => openURL(params),
  back: (params) => back(params),
  check: (params) => checkLayout(params),
  logs: (params) => getLogs(params),
  reload: () => reload(),
  screenshot: (params) => screenshot(params),
};
