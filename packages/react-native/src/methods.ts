import { audit, beginAction, uxCheck, back, getLogs, inspect, longPress, onActed, openURL, press, reload, screenshot, scroll, settleOutcome, swipe, toggle, typeText } from './actions';
import { checkLayout } from './checks';
import { crashAck } from './crash';
import { listCommands, runCommand } from './commands';
import { glassTree } from './glass';
import { overlay, tree } from './inspect';
import { media } from './media';
import { move } from './move';
import { placeData } from './place';
import { knownPlaces } from './routetree';
import { isRecord } from './types';
import { feedMethod, frameAfterAction } from './live';
import { perfStart, perfStop } from './perf';
import { waitFor } from './wait';

export type MethodFn = (params: unknown) => Promise<unknown>;

// The handler has run: viewers get their first frame now, not after the settle wait.
onActed(frameAfterAction);

/** An action changes the screen: let anyone watching see the result soon. */
function action(fn: MethodFn): MethodFn {
  return async (params) => {
    beginAction();
    try {
      return await fn(params);
    } finally {
      frameAfterAction();
    }
  };
}

/** Protocol method name -> implementation. */
export const methods: Record<string, MethodFn> = {
  tree: (params) => (isRecord(params) && params.glass === true ? glassTree(params) : tree(params)),
  press: action((params) => press(params)),
  longPress: action((params) => longPress(params)),
  type: action((params) => typeText(params)),
  scroll: action((params) => scroll(params)),
  toggle: action((params) => toggle(params)),
  openURL: action((params) => openURL(params)),
  back: action((params) => back(params)),
  swipe: action((params) => swipe(params)),
  check: (params) => checkLayout(params),
  commands: async () => ({ commands: listCommands() }),
  command: action(async (params) => {
    const ran = await runCommand(params);
    return { ...ran, ...(await settleOutcome()) };
  }),
  waitFor: (params) => waitFor(params),
  logs: (params) => getLogs(params),
  inspect: (params) => inspect(params),
  audit: (params) => audit(params),
  uxCheck: (params) => uxCheck(params),
  media: (params) => media(params),
  reload: () => reload(),
  perfStart: () => perfStart(),
  perfStop: (params) => perfStop(params),
  perfSettle: () => settleOutcome(),
  // The computer has the crash saved at `ts`: the phone may forget that one (and no other).
  crashAck: (params) => crashAck(params),
  screenshot: (params) => screenshot(params),
  feed: (params) => feedMethod(params),
  overlay: () => overlay(),
  // AGENT-TOOLS 1.13 §18: where the app is, the places its route tree lists, and one move with the next target waited for.
  place: async () => placeData(),
  places: async () => knownPlaces(),
  move: action((params) => move(params)),
};
