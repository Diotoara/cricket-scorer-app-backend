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
  Economy?: number;
  runsConceded?: number;
  wides?: number;
  NoBalls?: number;
  dots?: number;
}

export interface Team {
  name: string;
  totalRuns: number;
  wicketsLost: number;
  oversPlayed: number;
  ballsInCurrentOver: number;
  players: Player[];
  wonMatches?: number;
  lostMatches?: number;
  extras?: number;
}

export interface MatchState {
  teamA: Team;
  teamB: Team;
  currentInnings: "teamA" | "teamB";
  strikerId: string | null;
  nonStrikerId: string | null;
  currentBowlerId: string | null;
}
