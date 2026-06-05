import express, { Request, Response } from "express";
import cors from "cors";
import { supabase } from "./supabase";
import { MatchState } from "./types";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// 1. GET ROUTE: Fetch real-time score from Supabase
app.get("/api/match", async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from("matches")
      .select("state")
      .eq("id", "live-match")
      .single();

    if (error || !data) {
      return res
        .status(404)
        .json({ error: "Match state not found in database." });
    }

    // Return the nested match state JSON directly
    return res.json(data.state);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server database error." });
  }
});

// 2. POST ROUTE: Process a ball and save back to Supabase
app.post("/api/match/ball", async (req: Request, res: Response) => {
  const { runs } = req.body;

  if (typeof runs !== "number") {
    return res.status(400).json({ error: "Invalid runs data provided" });
  }

  try {
    // Fetch the current state from the database first
    const { data, error: fetchError } = await supabase
      .from("matches")
      .select("state")
      .eq("id", "live-match")
      .single();

    if (fetchError || !data) {
      return res
        .status(404)
        .json({ error: "Cannot find live-match to update." });
    }

    // Use type casting to tell TypeScript this is our MatchState layout
    let currentMatch = data.state as MatchState;

    const currentInningsKey = currentMatch.currentInnings;
    const battingTeam = currentMatch[currentInningsKey];
    const bowlingTeamKey = currentInningsKey === "teamA" ? "teamB" : "teamA";
    const bowlingTeam = currentMatch[bowlingTeamKey];

    const strikerId = currentMatch.strikerId;
    const bowlerId = currentMatch.currentBowlerId;

    // --- Execute Cricket Scoring Math ---
    battingTeam.totalRuns += runs;
    battingTeam.ballsInCurrentOver += 1;

    let overJustCompleted = false;
    if (battingTeam.ballsInCurrentOver === 6) {
      battingTeam.oversPlayed += 1;
      battingTeam.ballsInCurrentOver = 0;
      overJustCompleted = true;
    }

    if (strikerId) {
      const striker = battingTeam.players.find((p) => p.id === strikerId);
      if (striker) {
        striker.runsScored = (striker.runsScored || 0) + runs;
        striker.ballsFaced = (striker.ballsFaced || 0) + 1;
        if (runs === 4) striker.fours = (striker.fours || 0) + 1;
        if (runs === 6) striker.sixes = (striker.sixes || 0) + 1;

        if (striker.ballsFaced > 0) {
          striker.StrikeRate = parseFloat(
            ((striker.runsScored / striker.ballsFaced) * 100).toFixed(2),
          );
        }
      }
    }

    if (bowlerId) {
      const bowler = bowlingTeam.players.find((p) => p.id === bowlerId);
      if (bowler) {
        bowler.runsConceded = (bowler.runsConceded || 0) + runs;

        if (overJustCompleted) {
          bowler.oversBowled = (bowler.oversBowled || 0) + 1;
        }

        const fullOvers = bowler.oversBowled || 0;
        const currentOverBalls = battingTeam.ballsInCurrentOver;
        const totalBallsBowled = fullOvers * 6 + currentOverBalls;

        if (totalBallsBowled > 0) {
          const totalOversAsDecimal = totalBallsBowled / 6;
          bowler.Economy = parseFloat(
            (bowler.runsConceded / totalOversAsDecimal).toFixed(2),
          );
        }
      }
    }

    // --- Save the updated object back to Supabase ---
    const { error: updateError } = await supabase
      .from("matches")
      .update({ state: currentMatch, updated_at: new Date() })
      .eq("id", "live-match");

    if (updateError) {
      return res
        .status(500)
        .json({ error: "Failed to sync updated score to cloud database." });
    }

    // Return the newly saved state to the frontend
    return res.json(currentMatch);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server update handler crashed." });
  }
});

// Production Keep-Alive Health Route for Cron-Jobs
app.get("/api/health", (req: Request, res: Response) => {
  res.json({ status: "healthy", timestamp: new Date() });
});

app.listen(PORT, () => {
  console.log(
    `[server]: Full-stack database server running on http://localhost:${PORT}`,
  );
});
