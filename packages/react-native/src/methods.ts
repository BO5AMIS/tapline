import { back, getLogs, longPress, openURL, press, reload, screenshot, scroll, toggle, typeText } from './actions';
import { checkLayout } from './checks';
import { listCommands, runCommand } from './commands';
import { overlay, tree } from './inspect';
import { feedMethod, frameAfterAction } from './live';
import { waitFor } from './wait';

export type MethodFn = (params: unknown) => Promise<unknown>;

/** An action changes the screen: let anyone watching see the result soon. */
function action(fn: MethodFn): MethodFn {
  return async (params) => {
    try {
      return await fn(params);
    } finally {
      frameAfterAction();
    }
  };
}

/** Protocol method name -> implementation. */
export const methods: Record<string, MethodFn> = {
  tree: (params) => tree(params),
  press: action((params) => press(params)),
  longPress: action((params) => longPress(params)),
  type: action((params) => typeText(params)),
  scroll: action((params) => scroll(params)),
  toggle: action((params) => toggle(params)),
  openURL: action((params) => openURL(params)),
  back: action((params) => back(params)),
  check: (params) => checkLayout(params),
  commands: async () => ({ commands: listCommands() }),
  command: action((params) => runCommand(params)),
  waitFor: (params) => waitFor(params),
  logs: (params) => getLogs(params),
  reload: () => reload(),
  screenshot: (params) => screenshot(params),
  feed: (params) => feedMethod(params),
  overlay: () => overlay(),
};
