// What each platform's own rules say, and — separately — what MarketingOS
// chose (ticket 19; source: docs/issues/marketing-os/research/platform-policies-warmup.md,
// and the decision in docs/issues/marketing-os/issues/19-research-platform-policies-for-warmup.md).
//
// The distinction this module exists to keep is the honesty invariant: a
// number a platform published is a fact with a citation and a date; a
// number MarketingOS picked is a judgment call and says so. Only X
// publishes daily action numbers. Everything MarketingOS ships sits far
// below any published ceiling, because every one of those platforms says
// aggressive behaviour below the ceiling is still a violation.
//
// Policies change. Every citation carries the date it was observed, and
// nothing here should be read as current without re-checking it.

export const PLATFORMS = ["instagram", "tiktok", "x", "linkedin"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** What a brand's presence on this platform is allowed to be. */
export type IdentityKind = "page" | "business_account" | "profile";

export interface PlatformAnchor {
  /** The number the platform itself publishes. */
  value: number;
  unit: string;
  source: string;
  observedOn: string;
  /** Why the shipped cap is not this number. */
  note: string;
}

export interface DailyCap {
  action: string;
  perDay: number;
  /**
   * Always "judgment_call" for the shipped number: no platform publishes a
   * safe volume, only technical ceilings, and acting near one is itself a
   * violation. `platformAnchor` records the published ceiling where one
   * exists, so the two are never confused for each other.
   */
  basis: "judgment_call";
  platformAnchor: PlatformAnchor | null;
}

export interface PlatformPolicy {
  platform: Platform;
  /** The identity kinds a brand presence may take here. */
  allowedIdentityKinds: IdentityKind[];
  identityRule: string;
  disclosureRule: string;
  defaultCaps: DailyCap[];
}

const X_FOLLOW_ANCHOR: PlatformAnchor = {
  value: 400,
  unit: "follows/day",
  source: "https://help.x.com/en/using-x/x-follow-limit",
  observedOn: "2026-05-17",
  note: "X calls this a technical ceiling and says aggressive following below it still breaks the rules, so the shipped cap is a small fraction of it.",
};

const X_POST_ANCHOR: PlatformAnchor = {
  value: 50,
  unit: "original posts/day for unverified accounts",
  source: "https://help.x.com/en/rules-and-policies/x-limits",
  observedOn: "2026-06-08",
  note: "A technical limit, not a safe volume.",
};

/**
 * The shipped defaults. Low, configurable per slot, and never presented as
 * anything a platform sanctioned.
 */
export const PLATFORM_POLICIES: Record<Platform, PlatformPolicy> = {
  instagram: {
    platform: "instagram",
    allowedIdentityKinds: ["business_account", "profile"],
    identityRule:
      "Instagram requires accurate registration information and bans automated account creation and bought accounts. A brand presence is the brand's own account, created by hand.",
    disclosureRule:
      "Instagram's terms mandate the branded content tool for any third-party partnership; a professional account is required to use it.",
    defaultCaps: [
      { action: "follow", perDay: 10, basis: "judgment_call", platformAnchor: null },
      { action: "like", perDay: 30, basis: "judgment_call", platformAnchor: null },
      { action: "comment", perDay: 5, basis: "judgment_call", platformAnchor: null },
      { action: "post", perDay: 1, basis: "judgment_call", platformAnchor: null },
    ],
  },
  tiktok: {
    platform: "tiktok",
    allowedIdentityKinds: ["business_account", "profile"],
    identityRule:
      "TikTok allows multiple non-deceptive accounts. A brand presence must not impersonate anyone and must be created by hand.",
    disclosureRule:
      "TikTok mandates its disclosure toggle on every commercial post, including self-promotion (Branded Content Policy effective 2026-08-31).",
    defaultCaps: [
      { action: "follow", perDay: 10, basis: "judgment_call", platformAnchor: null },
      { action: "like", perDay: 30, basis: "judgment_call", platformAnchor: null },
      { action: "comment", perDay: 5, basis: "judgment_call", platformAnchor: null },
      { action: "post", perDay: 1, basis: "judgment_call", platformAnchor: null },
    ],
  },
  x: {
    platform: "x",
    allowedIdentityKinds: ["business_account", "profile"],
    identityRule:
      "X permits up to 10 non-duplicative accounts including manager-operated business accounts, but prohibits duplicates that amplify the same content.",
    disclosureRule:
      "X requires its Paid Partnership disclosure setting for any incentivized post.",
    defaultCaps: [
      { action: "follow", perDay: 20, basis: "judgment_call", platformAnchor: X_FOLLOW_ANCHOR },
      { action: "like", perDay: 40, basis: "judgment_call", platformAnchor: null },
      { action: "comment", perDay: 10, basis: "judgment_call", platformAnchor: null },
      { action: "post", perDay: 3, basis: "judgment_call", platformAnchor: X_POST_ANCHOR },
    ],
  },
  linkedin: {
    platform: "linkedin",
    // The rule this ticket names explicitly: LinkedIn allows exactly one
    // real-name member profile per person, so a brand presence there is a
    // Page. A persona profile is a policy violation, not a risk trade-off.
    allowedIdentityKinds: ["page"],
    identityRule:
      "LinkedIn allows exactly one real-name member profile per person, so a brand presence must be a Page and never a persona profile.",
    disclosureRule:
      "LinkedIn requires clear textual disclosure for any compensated endorsement.",
    defaultCaps: [
      { action: "invite", perDay: 5, basis: "judgment_call", platformAnchor: null },
      { action: "like", perDay: 20, basis: "judgment_call", platformAnchor: null },
      { action: "comment", perDay: 5, basis: "judgment_call", platformAnchor: null },
      { action: "post", perDay: 1, basis: "judgment_call", platformAnchor: null },
    ],
  },
};

/** Conservative windows, in the slot's own local time. Also a judgment call. */
export const DEFAULT_WINDOWS = [{ start: "09:00", end: "12:00" }, { start: "17:00", end: "20:00" }];

export function policyFor(platform: Platform): PlatformPolicy {
  return PLATFORM_POLICIES[platform];
}

/**
 * Why this identity is not allowed on this platform, or null when it is.
 * The message is the platform's rule, not our preference.
 */
export function identityRefusal(platform: Platform, kind: IdentityKind): string | null {
  const policy = policyFor(platform);
  if (policy.allowedIdentityKinds.includes(kind)) return null;
  return `${policy.identityRule} A ${kind} is not one of: ${policy.allowedIdentityKinds.join(", ")}.`;
}

/** Every cap MarketingOS picked without a published number behind it. */
export function judgmentCallCaps(caps: DailyCap[]): DailyCap[] {
  return caps.filter((cap) => cap.platformAnchor === null);
}
