import { propsOf, type Fiber } from './fiber';

/**
 * AGENT-TOOLS 1.15 §25.5 and §25.6: what the app tells the explorer. `taplineExploreSkip` keeps the explorer away from an element
 * and everything inside it. `taplineExploreFill` marks an input the explorer may type into when it runs with `fill: "test-data"`.
 */
export type TaplineExploreFill = true | `vault:${string}` | `fixture:${string}`;

/** The props an app puts on a View, a Pressable, a TextInput or one of its own components. */
export interface TaplineExploreProps {
  /** The explorer never touches this element or anything inside it. */
  taplineExploreSkip?: boolean;
  /** An input the explorer may fill: `true` (a fake value), `"vault:<entry>.<field>"` or `"fixture:<name>"`. */
  taplineExploreFill?: TaplineExploreFill;
}

/** What a subtree carries down: skip is sticky, the nearest fill mark wins. */
export interface ExploreMarks {
  skip?: true;
  fill?: TaplineExploreFill;
}

function fillOf(value: unknown): TaplineExploreFill | undefined {
  if (value === true) return true;
  if (typeof value === 'string' && /^(vault|fixture):.+/.test(value)) return value as TaplineExploreFill;
  return undefined;
}

/** The marks that hold at this fiber: the ones inherited, plus the fiber's own props. The same object back when nothing is added. */
export function exploreMarksOf(fiber: Fiber, inherited: ExploreMarks | undefined): ExploreMarks | undefined {
  const props = propsOf(fiber);
  const skip = props.taplineExploreSkip === true;
  const fill = fillOf(props.taplineExploreFill);
  if (!skip && fill === undefined) return inherited;
  const skipped = skip || inherited?.skip === true;
  const filled = fill ?? inherited?.fill;
  return { ...(skipped ? { skip: true as const } : {}), ...(filled !== undefined ? { fill: filled } : {}) };
}
