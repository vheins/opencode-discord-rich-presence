/**
 * Discord activity builder — maps the internal `PresenceModel` to the wire shape.
 *
 * Pure mapping plus validation: caps text at 128 characters and asset keys at 32,
 * enforces the RPC activity-type subset `{0,2,3,5}` and the button limits (max 2,
 * label 1..32, `https://` URL 1..512). A `null` model maps to `null`, which clears the
 * presence card (`docs/DISCORD-RPC.md` §4.2–§4.4).
 */
import type { PresenceButton, PresenceModel, RpcActivityType } from "../types";

/** Activity types accepted over RPC. */
export type ActivityType = RpcActivityType;

/** Discord activity assets block. */
export type ActivityAssets = {
  /** Large image key or external URL. */
  large_image?: string;
  /** Large image hover text. */
  large_text?: string;
  /** Small image key or external URL. */
  small_image?: string;
  /** Small image hover text. */
  small_text?: string;
};

/** Discord activity timestamps block, in epoch seconds for RPC. */
export type ActivityTimestamps = {
  /** Count-up anchor in epoch seconds. */
  start?: number;
  /** Count-down deadline in epoch seconds. */
  end?: number;
};

/** Discord party block. */
export type ActivityParty = {
  /** Party identifier. */
  id?: string;
  /** `[current, max]` member counts. */
  size?: [number, number];
};

/** Discord activity button. */
export type ActivityButton = {
  /** Button label, 1..32 characters. */
  label: string;
  /** Destination URL, 1..512 characters, `https://` only. */
  url: string;
};

/** Discord activity payload accepted by `SET_ACTIVITY`. */
export type Activity = {
  /** RPC activity type. */
  type?: ActivityType;
  /** Activity name override; Discord shows it after the verb on the top line. */
  name?: string;
  /** Primary description line. */
  details?: string;
  /** Secondary status line. */
  state?: string;
  /** Elapsed/remaining timer block. */
  timestamps?: ActivityTimestamps;
  /** Artwork block. */
  assets?: ActivityAssets;
  /** Party size/id block. */
  party?: ActivityParty;
  /** Up to two call-to-action buttons. */
  buttons?: ActivityButton[];
  /** Whether the activity represents a joinable instance. */
  instance?: boolean;
};

/** Options controlling activity construction. */
export interface BuildActivityOptions {
  /** RPC activity type; falls back to the model's type, then `0` (Playing). */
  type?: ActivityType;
  /** Party block override; falls back to the model's party. */
  party?: ActivityParty;
  /** Override the model's buttons. */
  buttons?: PresenceButton[];
  /** Validate the result and throw on hard violations; defaults to true. */
  validate?: boolean;
}

/** Maximum characters for `details`, `state` and asset hover text. */
export const ACTIVITY_TEXT_MAX = 128;

/** Maximum characters for asset keys. */
export const ACTIVITY_ASSET_KEY_MAX = 32;

/** Maximum number of buttons Discord accepts. */
export const ACTIVITY_BUTTON_MAX = 2;

/** Activity types allowed over RPC (`docs/DISCORD-RPC.md` §4.1). */
export const ACTIVITY_TYPES: readonly ActivityType[] = [0, 2, 3, 5];

/** Clamp a string to a maximum length. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Build the assets block, omitting empty fields. */
function buildAssets(model: PresenceModel): ActivityAssets | undefined {
  const assets: ActivityAssets = {};
  if (model.largeImageKey !== "") {
    assets.large_image = truncate(model.largeImageKey, ACTIVITY_ASSET_KEY_MAX);
  }
  if (model.largeImageText !== "") {
    assets.large_text = truncate(model.largeImageText, ACTIVITY_TEXT_MAX);
  }
  if (model.smallImageKey !== undefined && model.smallImageKey !== "") {
    assets.small_image = truncate(model.smallImageKey, ACTIVITY_ASSET_KEY_MAX);
  }
  if (model.smallImageText !== undefined && model.smallImageText !== "") {
    assets.small_text = truncate(model.smallImageText, ACTIVITY_TEXT_MAX);
  }
  return Object.keys(assets).length > 0 ? assets : undefined;
}

/** Build the button list, preserving order and clamping to the maximum. */
function buildButtons(buttons: PresenceButton[] | undefined): ActivityButton[] | undefined {
  if (buttons === undefined || buttons.length === 0) {
    return undefined;
  }
  return buttons.slice(0, ACTIVITY_BUTTON_MAX).map((button) => ({
    label: truncate(button.label, 32),
    url: button.url,
  }));
}

/**
 * Validate an activity against the RPC contract, throwing on hard violations.
 *
 * @param activity Activity payload to check.
 * @throws RangeError When the type, buttons or party size are invalid.
 */
export function validateActivity(activity: Activity): void {
  if (activity.type !== undefined && !ACTIVITY_TYPES.includes(activity.type)) {
    throw new RangeError(
      `activity.type ${activity.type} is not valid over RPC (allowed: 0, 2, 3, 5)`,
    );
  }
  const buttons = activity.buttons ?? [];
  if (buttons.length > ACTIVITY_BUTTON_MAX) {
    throw new RangeError(`activity.buttons must contain at most ${ACTIVITY_BUTTON_MAX} entries`);
  }
  for (const button of buttons) {
    if (button.label.length < 1 || button.label.length > 32) {
      throw new RangeError("button.label must be 1..32 characters");
    }
    if (button.url.length < 1 || button.url.length > 512) {
      throw new RangeError("button.url must be 1..512 characters");
    }
    if (!button.url.startsWith("https://")) {
      throw new RangeError("button.url must start with https://");
    }
  }
  const size = activity.party?.size;
  if (size !== undefined) {
    const [current, max] = size;
    if (!Number.isInteger(current) || !Number.isInteger(max) || current > max) {
      throw new RangeError("party.size must be [current, max] with current <= max");
    }
  }
}

/**
 * Map a presence model to a Discord activity payload.
 *
 * @param model Presence model, or `null` to clear the card.
 * @param options Activity type, party and validation overrides.
 * @returns The activity payload, or `null` when clearing.
 * @throws RangeError When validation is enabled and the activity is invalid.
 */
export function buildActivity(
  model: PresenceModel | null,
  options: BuildActivityOptions = {},
): Activity | null {
  if (model === null) {
    return null;
  }
  const activity: Activity = { type: options.type ?? model.activityType ?? 0 };
  const name = model.activityName;
  if (name !== undefined && name !== "") {
    activity.name = truncate(name, ACTIVITY_TEXT_MAX);
  }
  if (model.details !== "") {
    activity.details = truncate(model.details, ACTIVITY_TEXT_MAX);
  }
  if (model.state !== undefined && model.state !== "") {
    activity.state = truncate(model.state, ACTIVITY_TEXT_MAX);
  }
  if (model.startTimestamp !== undefined) {
    activity.timestamps = { start: model.startTimestamp };
  }
  const assets = buildAssets(model);
  if (assets !== undefined) {
    activity.assets = assets;
  }
  const buttons = buildButtons(options.buttons ?? model.buttons);
  if (buttons !== undefined) {
    activity.buttons = buttons;
  }
  const party = options.party ?? model.party;
  if (party !== undefined) {
    activity.party = party;
  }
  if (model.instance !== undefined) {
    activity.instance = model.instance;
  }
  if (options.validate ?? true) {
    validateActivity(activity);
  }
  return activity;
}
