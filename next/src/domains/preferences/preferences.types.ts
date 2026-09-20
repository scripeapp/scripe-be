export interface PreferencesOperation {
  readonly userId: string;
  readonly requestId: string;
}

export type Preferences = Record<string, unknown>;

export interface PreferencesResponse {
  readonly preferences: Preferences;
}
