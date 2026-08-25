export const DISCOURSE_MODES = [
  "narrative",
  "dialogue",
  "action",
  "description",
  "technical",
  "documentary",
  "lyrical",
  "interior",
] as const;

export type DiscourseMode = typeof DISCOURSE_MODES[number];
export type DiscourseModeWeights = Readonly<Record<DiscourseMode, number>>;

export interface BookStyleConstitution {
  readonly schemaVersion: "v5-book-style-1";
  readonly version: number;
  readonly register: string;
  readonly sentencePolicy: string;
  readonly explicitation: string;
  readonly imagery: string;
  readonly dialogue: string;
  readonly technicalProse: string;
  readonly typography: string;
  readonly additionalInstruction: string;
}

export type VoiceScope =
  | "main_narrator"
  | "character"
  | "letter"
  | "document"
  | "quoted_voice";

export interface VoiceProfile {
  readonly voiceId: string;
  readonly scope: VoiceScope;
  readonly instruction: string;
  readonly confidence: number;
}

export interface StyleAddressChoice {
  readonly subject: string;
  readonly target: string;
}

export interface StyleLexicalChoice {
  readonly source: string;
  readonly target: string;
}

export interface StyleObservationSubmission {
  readonly voiceId?: string;
  readonly activeRegister?: string;
  readonly rhythm?: string;
  readonly addressChoices?: readonly StyleAddressChoice[];
  readonly lexicalChoices?: readonly StyleLexicalChoice[];
  readonly continuityNotes?: readonly string[];
  readonly modeWeights?: Partial<Record<DiscourseMode, number>>;
}

export interface LocalStyleObservation {
  readonly schemaVersion: "v5-style-observation-1";
  readonly windowId: string;
  readonly ordinal: number;
  readonly accepted: boolean;
  readonly voiceId: string;
  readonly modeWeights: DiscourseModeWeights;
  readonly activeRegister: string | null;
  readonly rhythm: string | null;
  readonly addressChoices: readonly StyleAddressChoice[];
  readonly lexicalChoices: readonly StyleLexicalChoice[];
  readonly continuityNotes: readonly string[];
  readonly examples: readonly string[];
}

export interface WeightedStyleValue {
  readonly value: string;
  readonly weight: number;
}

export interface WeightedAddressChoice extends StyleAddressChoice {
  readonly weight: number;
}

export interface WeightedLexicalChoice extends StyleLexicalChoice {
  readonly weight: number;
}

export interface EffectiveLocalStyle {
  readonly registers: readonly WeightedStyleValue[];
  readonly rhythms: readonly WeightedStyleValue[];
  readonly addressChoices: readonly WeightedAddressChoice[];
  readonly lexicalChoices: readonly WeightedLexicalChoice[];
  readonly continuityNotes: readonly WeightedStyleValue[];
}

export interface EffectiveStyle {
  readonly constitution: BookStyleConstitution;
  readonly voice: VoiceProfile;
  readonly modeWeights: DiscourseModeWeights;
  readonly topModes: readonly DiscourseMode[];
  readonly local: EffectiveLocalStyle;
  readonly examples: readonly string[];
}

export interface EffectiveStyleProjection {
  readonly schemaVersion: "v5-effective-style-1";
  readonly constitutionVersion: number;
  readonly voiceId: string;
  readonly modeWeights: DiscourseModeWeights;
  readonly modeRules: readonly string[];
  readonly examples: readonly string[];
  readonly text: string;
}
