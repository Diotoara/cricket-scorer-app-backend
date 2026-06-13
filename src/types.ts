export interface Player {
  id: string;
  name: string;
  runsScored?: number;
  ballsFaced?: number;
  fours?: number;
  sixes?: number;
  StrikeRate?: number;

  wicketsTaken?: number;
  oversBowled?: number;
  wicketDetails?: WicketDetails;
  // True when the batsman left the crease injured (retired hurt). They are NOT
  // out, keep their score, and can return to bat later.
  retiredHurt?: boolean;
  Economy?: number;
  runsConceded?: number;
  wides?: number;
  NoBalls?: number;
  deliveryHistory?: string[];
  dots?: number;
}

export interface WicketDetails {
  type: "bowled" | "stumped" | "caught" | "runout";
  fieldedBy?: string; // Player ID or Name of the fielder
}

export interface Team {
  teamId?: string | undefined; // FK into the persistent `teams` table (for points attribution)
  name: string;
  totalRuns: number;
  wicketsLost: number;
  oversPlayed: number;
  ballsInCurrentOver: number;
  players: Player[];
  wonMatches?: number;
  lostMatches?: number;
  extras?: number;
  inningsComplete?: boolean;
}

export interface MatchState {
  teamA: Team;
  teamB: Team;
  currentInnings: "teamA" | "teamB";
  strikerId: string | null;
  nonStrikerId: string | null;
  currentBowlerId: string | null;
  totalOvers?: number;
  target?: number;
  resultRecorded?: boolean; // guards /api/match/finish against double-counting points
}
