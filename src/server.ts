import express, { Request, Response } from "express";
import cors from "cors";
import { supabase } from "./supabase";
import { MatchState, Player } from "./types";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
// Raised limit so base64 player avatars fit in the JSON body (default is 100kb).
app.use(express.json({ limit: "12mb" }));

function getActiveBowler(currentMatch: MatchState) {
  const currentInningsKey = currentMatch.currentInnings;
  const bowlingTeamKey = currentInningsKey === "teamA" ? "teamB" : "teamA";
  const bowlingTeam = currentMatch[bowlingTeamKey];

  if (!bowlingTeam || !currentMatch.currentBowlerId) return null;

  const bowler = bowlingTeam.players.find(
    (p) => p.id === currentMatch.currentBowlerId,
  );

  // Lazy-initialize the array if it doesn't exist in Supabase yet
  if (bowler && !bowler.deliveryHistory) {
    bowler.deliveryHistory = [];
  }

  return bowler;
}

// ==========================================
// INNINGS COMPLETION CHECK HELPER
// ==========================================
function checkInningsComplete(currentMatch: MatchState): boolean {
  const currentInningsKey = currentMatch.currentInnings;
  const battingTeam = currentMatch[currentInningsKey];
  const totalOvers = currentMatch.totalOvers || 0; // 0 means unlimited overs

  // Check if the innings should end:
  // 1. Overs limit reached (only if totalOvers is set and > 0)
  // 2. All out (10 wickets lost)
  const oversExhausted = totalOvers > 0 && battingTeam.oversPlayed >= totalOvers;
  const allOut = battingTeam.wicketsLost >= 10;

  if (!oversExhausted && !allOut) {
    return false; // Innings continues
  }

  // Mark this team's innings as complete
  battingTeam.inningsComplete = true;

  if (currentInningsKey === "teamA") {
    // --- 1ST INNINGS OVER: Switch to teamB batting ---
    currentMatch.currentInnings = "teamB";
    currentMatch.target = battingTeam.totalRuns + 1; // Target = 1st innings total + 1
    currentMatch.strikerId = null;
    currentMatch.nonStrikerId = null;
    currentMatch.currentBowlerId = null;
  } else {
    // --- 2ND INNINGS OVER: Match is complete ---
    // The 2nd batting team didn't chase the target, so the match ends naturally.
    // No further innings change needed.
  }

  return true; // Innings did change (or match ended)
}

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

// ==========================================
// 1. STANDARD BALL & RUNS ENDPOINT
// ==========================================
app.post("/api/match/ball", async (req: Request, res: Response) => {
  const { runs } = req.body;

  if (typeof runs !== "number") {
    return res.status(400).json({ error: "Invalid runs data provided" });
  }

  try {
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

    let currentMatch = data.state as MatchState;
    (currentMatch as any).lastBallBatsmanId = currentMatch.strikerId;
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
      currentMatch.currentBowlerId = null;
    }

    // --- Check if 2nd innings target has been chased ---
    let targetChased = false;
    if (currentMatch.target && currentMatch.target > 0 && battingTeam.totalRuns >= currentMatch.target) {
      targetChased = true;
    }

    // --- Batsman Updates ---
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

    // --- Bowler Updates (with DB Force-Write) ---
    if (bowlerId) {
      const bowlerObj = bowlingTeam.players.find((p) => p.id === bowlerId);
      if (bowlerObj) {
        // 🌟 FORCE CREATE ARRAY IF IT DOES NOT EXIST IN DATABASE
        if (
          !bowlerObj.deliveryHistory ||
          !Array.isArray(bowlerObj.deliveryHistory)
        ) {
          bowlerObj.deliveryHistory = [];
        }

        // Push the run to history
        bowlerObj.deliveryHistory.push(String(runs));

        // Update basic bowler stats
        bowlerObj.runsConceded = (bowlerObj.runsConceded || 0) + runs;

        if (overJustCompleted) {
          bowlerObj.oversBowled = (bowlerObj.oversBowled || 0) + 1;
          bowlerObj.deliveryHistory.push("|"); // Add over divider
        }

        const fullOvers = bowlerObj.oversBowled || 0;
        const currentOverBalls = battingTeam.ballsInCurrentOver;
        const totalBallsBowled = fullOvers * 6 + currentOverBalls;

        if (totalBallsBowled > 0) {
          const totalOversAsDecimal = totalBallsBowled / 6;
          bowlerObj.Economy = parseFloat(
            (bowlerObj.runsConceded / totalOversAsDecimal).toFixed(2),
          );
        }
      }
    }

    // --- Smart Strike Rotation Logic ---
    let swapStrike = false;

    if ((runs === 1 || runs === 3) && !overJustCompleted) {
      swapStrike = !swapStrike;
    }

    if (overJustCompleted && runs !== 1 && runs !== 3) {
      swapStrike = !swapStrike;
    }

    if (swapStrike && currentMatch.strikerId && currentMatch.nonStrikerId) {
      const temp = currentMatch.strikerId;
      currentMatch.strikerId = currentMatch.nonStrikerId;
      currentMatch.nonStrikerId = temp;
    }

    // --- Check for innings completion (overs exhausted or all-out) ---
    let inningsChanged = false;
    if (overJustCompleted) {
      inningsChanged = checkInningsComplete(currentMatch);
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

    return res.status(200).json({ ...currentMatch, inningsChanged, targetChased });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server update handler crashed." });
  }
});

app.post("/api/match/swap-strike", async (req: Request, res: Response) => {
  try {
    const { data, error: fetchError } = await supabase
      .from("matches")
      .select("state")
      .eq("id", "live-match")
      .single();

    if (fetchError || !data) {
      return res.status(404).json({ error: "Live match not found." });
    }

    let currentMatch = data.state as MatchState;

    // --- 1. ONLY EXECUTE THE FORCED POSITIONAL STRIKE SWAP ---
    // No ball counting, no batsman stats updates, no bowler economy calculations.
    if (currentMatch.strikerId && currentMatch.nonStrikerId) {
      const temp = currentMatch.strikerId;
      currentMatch.strikerId = currentMatch.nonStrikerId;
      currentMatch.nonStrikerId = temp;
    }

    // --- 2. Save back to Supabase ---
    const { error: updateError } = await supabase
      .from("matches")
      .update({ state: currentMatch, updated_at: new Date() })
      .eq("id", "live-match");

    if (updateError) {
      return res
        .status(500)
        .json({ error: "Failed to save live swap strike event." });
    }

    // Send the updated state back to the app
    return res.json(currentMatch);
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: "Server failed to process manual swap strike." });
  }
});

app.post("/api/match/noball", async (req: Request, res: Response) => {
  const { runs } = req.body; // Expecting { runs: 0 } or optional additional runs hit by batter
  const additionalRuns = typeof runs === "number" ? runs : 0;

  try {
    const { data, error: fetchError } = await supabase
      .from("matches")
      .select("state")
      .eq("id", "live-match")
      .single();

    if (fetchError || !data)
      return res.status(404).json({ error: "Match not found." });

    let currentMatch = data.state as any;
    const battingTeam = currentMatch[currentMatch.currentInnings];
    const bowlingTeam =
      currentMatch[currentMatch.currentInnings === "teamA" ? "teamB" : "teamA"];
    const strikerId = currentMatch.strikerId;
    const bowlerId = currentMatch.currentBowlerId;
    const bowler = getActiveBowler(currentMatch);
    if (bowler) {
      if (!bowler.deliveryHistory) bowler.deliveryHistory = [];
      if (runs > 0) {
        bowler.deliveryHistory.push(`NB+${runs}`);
      } else {
        bowler.deliveryHistory.push("NB");
      }
    }

    battingTeam.totalRuns += additionalRuns;

    if (bowlerId) {
      const bowler = bowlingTeam.players.find((p: any) => p.id === bowlerId);
      if (bowler) {
        bowler.noBalls = (bowler.noBalls || 0) + 1;
        bowler.runsConceded = (bowler.runsConceded || 0) + additionalRuns;

        const totalBalls =
          (bowler.oversBowled || 0) * 6 + (battingTeam.ballsInCurrentOver || 0);
        if (totalBalls > 0) {
          bowler.Economy = parseFloat(
            (bowler.runsConceded / (totalBalls / 6)).toFixed(2),
          );
        }
      }
    }

    // If the batter scored runs off the No Ball, update their stats too!
    if (strikerId && additionalRuns > 0) {
      const striker = battingTeam.players.find((p: any) => p.id === strikerId);
      if (striker) {
        striker.runsScored = (striker.runsScored || 0) + additionalRuns;
        striker.ballsFaced = (striker.ballsFaced || 0) + 1; // Facing a no-ball counts for the batsman
        if (additionalRuns === 4) striker.fours = (striker.fours || 0) + 1;
        if (additionalRuns === 6) striker.sixes = (striker.sixes || 0) + 1;
        striker.StrikeRate = parseFloat(
          ((striker.runsScored / striker.ballsFaced) * 100).toFixed(2),
        );
      }
    }

    const { error: updateError } = await supabase
      .from("matches")
      .update({ state: currentMatch, updated_at: new Date() })
      .eq("id", "live-match");

    if (updateError)
      return res.status(500).json({ error: "Database sync failed." });
    return res.json(currentMatch);
  } catch (err) {
    return res.status(500).json({ error: "Server no-ball processor crashed." });
  }
});

app.post("/api/match/wide", async (req: Request, res: Response) => {
  try {
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

    let currentMatch = data.state as MatchState;

    const currentInningsKey = currentMatch.currentInnings;
    const battingTeam = currentMatch[currentInningsKey];
    const bowlingTeamKey = currentInningsKey === "teamA" ? "teamB" : "teamA";
    const bowlingTeam = currentMatch[bowlingTeamKey];

    const bowlerId = currentMatch.currentBowlerId;

    // --- Wide Team Math ---
    // A wide adds 1 run to the total and 1 to extras, but NO balls are added to the over.
    battingTeam.totalRuns += 1;
    battingTeam.extras = (battingTeam.extras || 0) + 1;

    // --- Bowler Updates (with DB Force-Write) ---
    if (bowlerId) {
      const bowlerObj = bowlingTeam.players.find((p) => p.id === bowlerId);
      if (bowlerObj) {
        // 🌟 FORCE CREATE ARRAY IF IT DOES NOT EXIST IN DATABASE
        if (
          !bowlerObj.deliveryHistory ||
          !Array.isArray(bowlerObj.deliveryHistory)
        ) {
          bowlerObj.deliveryHistory = [];
        }

        // Add WD to history
        bowlerObj.deliveryHistory.push("WD");

        // Wides count against the bowler's runs conceded
        bowlerObj.runsConceded = (bowlerObj.runsConceded || 0) + 1;
        bowlerObj.wides = (bowlerObj.wides || 0) + 1;

        // Recalculate Economy
        const fullOvers = bowlerObj.oversBowled || 0;
        const currentOverBalls = battingTeam.ballsInCurrentOver;
        const totalBallsBowled = fullOvers * 6 + currentOverBalls;

        if (totalBallsBowled > 0) {
          const totalOversAsDecimal = totalBallsBowled / 6;
          bowlerObj.Economy = parseFloat(
            (bowlerObj.runsConceded / totalOversAsDecimal).toFixed(2),
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
        .json({ error: "Failed to sync wide to cloud database." });
    }

    return res.status(200).json(currentMatch);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server wide handler crashed." });
  }
});

app.get("/api/health", (req: Request, res: Response) => {
  res.json({ status: "healthy", timestamp: new Date() });
});

// ==========================================
// 3. WICKET OUT ENDPOINT
// ==========================================
app.post("/api/match/wicket", async (req: Request, res: Response) => {
  // 🌟 Added dismissedPlayerSlot from the request body to catch runouts accurately
  const { wicketType, fielderId, runsScored, dismissedPlayerSlot } = req.body;

  try {
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

    let currentMatch = data.state as MatchState;
    const currentInningsKey = currentMatch.currentInnings;
    const battingTeam = currentMatch[currentInningsKey];
    const bowlingTeamKey = currentInningsKey === "teamA" ? "teamB" : "teamA";
    const bowlingTeam = currentMatch[bowlingTeamKey];

    const bowlerId = currentMatch.currentBowlerId;

    // 🌟 1. Determine EXACTLY who got out (Striker vs Non-Striker)
    // Runouts pass "nonStriker" or "striker". Regular wickets default to striker.
    const isStrikerDismissed =
      !dismissedPlayerSlot || dismissedPlayerSlot === "striker";
    const dismissedPlayerId = isStrikerDismissed
      ? currentMatch.strikerId
      : currentMatch.nonStrikerId;

    if (!dismissedPlayerId) {
      return res
        .status(400)
        .json({ error: "No batsman found in the selected slot to dismiss." });
    }

    // 2. Core Team Scoring Math
    battingTeam.ballsInCurrentOver += 1;
    battingTeam.wicketsLost = (battingTeam.wicketsLost || 0) + 1;

    let overJustCompleted = false;
    if (battingTeam.ballsInCurrentOver === 6) {
      battingTeam.oversPlayed += 1;
      battingTeam.ballsInCurrentOver = 0;
      overJustCompleted = true;
      currentMatch.currentBowlerId = null;
    }

    // Find the fielder's name if an ID was passed
    let fielderName = "";
    if (fielderId) {
      const fielder = bowlingTeam.players.find((p) => p.id === fielderId);
      if (fielder) fielderName = fielder.name;
    }

    // 3. Update Out Batsman Stats & Dismissal Record
    const deadBatsman = battingTeam.players.find(
      (p) => p.id === dismissedPlayerId,
    );
    if (deadBatsman) {
      deadBatsman.ballsFaced = (deadBatsman.ballsFaced || 0) + 1;

      // Save dismissal info to the database row
      deadBatsman.wicketDetails = {
        type: wicketType,
        ...(fielderName && { fieldedBy: fielderName }),
      };

      // 🌟 Crucial for Undo: Tag their position context right on the player item
      (deadBatsman as any).wasStrikerWhenOut = isStrikerDismissed;
    }

    // 4. Update Bowler Stats (Runouts don't count towards the bowler's wickets)
    if (bowlerId) {
      const bowlerObj = bowlingTeam.players.find((p) => p.id === bowlerId);
      if (bowlerObj) {
        if (
          !bowlerObj.deliveryHistory ||
          !Array.isArray(bowlerObj.deliveryHistory)
        ) {
          bowlerObj.deliveryHistory = [];
        }

        // Push "W" into timeline
        bowlerObj.deliveryHistory.push("W");

        // Bowler only gets credit if it isn't a runout
        if (wicketType !== "runout") {
          bowlerObj.wicketsTaken = (bowlerObj.wicketsTaken || 0) + 1;
        }

        if (overJustCompleted) {
          bowlerObj.oversBowled = (bowlerObj.oversBowled || 0) + 1;
          bowlerObj.deliveryHistory.push("|");
        }

        // Recalculate Economy safely
        const fullOvers = bowlerObj.oversBowled || 0;
        const currentOverBalls = battingTeam.ballsInCurrentOver;
        const totalBallsBowled = fullOvers * 6 + currentOverBalls;

        if (totalBallsBowled > 0) {
          const totalOversAsDecimal = totalBallsBowled / 6;
          const runsConceded = bowlerObj.runsConceded || 0;
          bowlerObj.Economy = parseFloat(
            (runsConceded / totalOversAsDecimal).toFixed(2),
          );
        }
      }
    }

    // 🌟 5. Track IDs explicitly for the Undo history layer
    (currentMatch as any).lastDismissedPlayerId = dismissedPlayerId;
    (currentMatch as any).lastBallBatsmanId = currentMatch.strikerId; // Who actually faced the delivery

    // 6. Strike Rotations / Management
    if (isStrikerDismissed) {
      currentMatch.strikerId = null; // Clear out the striker slot
      if (overJustCompleted) {
        // If the over ended simultaneously, the living non-striker switches over to strike end next over
        currentMatch.strikerId = currentMatch.nonStrikerId;
        currentMatch.nonStrikerId = null;
      }
    } else {
      currentMatch.nonStrikerId = null; // Clear out non-striker slot (Runout)
      if (overJustCompleted) {
        // If the over ended simultaneously, the living striker goes to the non-striker end
        currentMatch.nonStrikerId = currentMatch.strikerId;
        currentMatch.strikerId = null;
      }
    }

    // --- Check for innings completion (all-out or overs exhausted on wicket ball) ---
    let inningsChanged = false;
    inningsChanged = checkInningsComplete(currentMatch);

    const { error: updateError } = await supabase
      .from("matches")
      .update({ state: currentMatch, updated_at: new Date() })
      .eq("id", "live-match");

    if (updateError) {
      return res
        .status(500)
        .json({ error: "Failed to sync wicket to cloud database." });
    }

    return res.status(200).json({ ...currentMatch, inningsChanged });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server wicket handler crashed." });
  }
});

app.post("/api/match/undo", async (req: Request, res: Response) => {
  try {
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

    let currentMatch = data.state as MatchState;
    if (!currentMatch) {
      return res.status(404).json({ message: "No active match found" });
    }

    const currentInningsKey = currentMatch.currentInnings;
    const battingTeam = currentMatch[currentInningsKey];
    const bowlingTeamKey = currentInningsKey === "teamA" ? "teamB" : "teamA";
    const bowlingTeam = currentMatch[bowlingTeamKey];

    // 1. Grab active bowler
    const bowler = bowlingTeam.players.find(
      (p) => p.id === currentMatch.currentBowlerId,
    );
    if (
      !bowler ||
      !bowler.deliveryHistory ||
      bowler.deliveryHistory.length === 0
    ) {
      return res
        .status(400)
        .json({ message: "No delivery history available to undo" });
    }

    // 2. Pop the last ball from history
    let poppedBall = bowler.deliveryHistory.pop();
    if (!poppedBall) {
      return res.status(400).json({ message: "No deliveries found to undo" });
    }

    if (poppedBall === "|") {
      if (bowler.deliveryHistory.length === 0) {
        return res
          .status(400)
          .json({ message: "No balls left to undo before this over" });
      }
      poppedBall = bowler.deliveryHistory.pop()!;

      if (battingTeam.ballsInCurrentOver === 0 && battingTeam.oversPlayed > 0) {
        battingTeam.oversPlayed -= 1;
        battingTeam.ballsInCurrentOver = 6;
      }
    }

    const lastBall = poppedBall as string;

    // Guard bowler options
    if (bowler.wicketsTaken === undefined) bowler.wicketsTaken = 0;
    if (bowler.runsConceded === undefined) bowler.runsConceded = 0;
    if (bowler.oversBowled === undefined) bowler.oversBowled = 0;

    // Extract custom history ids
    const targetLastDismissedId = (currentMatch as any).lastDismissedPlayerId;
    const historicalBatsmanId =
      (currentMatch as any).lastBallBatsmanId || currentMatch.strikerId;

    // 3. Reverse stats based on ball type
    if (lastBall === "W") {
      // --- 🔴 UNDO WICKET & RESURRECT PLAYER ---
      battingTeam.wicketsLost = Math.max(0, battingTeam.wicketsLost - 1);
      if (bowler.wicketsTaken > 0) bowler.wicketsTaken -= 1;

      // Find the player who was dismissed
      const resurrectedPlayer = battingTeam.players.find(
        (p) => p.id === targetLastDismissedId,
      );

      if (resurrectedPlayer) {
        // Remove their out status
        delete resurrectedPlayer.wicketDetails;
        resurrectedPlayer.ballsFaced = Math.max(
          0,
          (resurrectedPlayer.ballsFaced || 0) - 1,
        );

        // 🌟 Fixed: Cast to any to safely check our custom dynamic flag
        const wasStriker = (resurrectedPlayer as any).wasStrikerWhenOut;

        // Put them back into the exact slot they occupied
        if (wasStriker || !currentMatch.strikerId) {
          currentMatch.strikerId = targetLastDismissedId;
        } else {
          currentMatch.nonStrikerId = targetLastDismissedId;
        }

        // Clean up the temporary flag so the player object stays pristine
        delete (resurrectedPlayer as any).wasStrikerWhenOut;
      }

      battingTeam.ballsInCurrentOver = Math.max(
        0,
        battingTeam.ballsInCurrentOver - 1,
      );

      // Reset tracking keys
      (currentMatch as any).lastDismissedPlayerId = null;
    } else if (lastBall.includes("WD")) {
      // --- UNDO WIDE ---
      battingTeam.totalRuns = Math.max(0, battingTeam.totalRuns - 1);
      bowler.runsConceded = Math.max(0, bowler.runsConceded - 1);
    } else if (lastBall.includes("NB")) {
      // --- UNDO NO BALL ---
      const splitParts = lastBall.split("+");
      const runsOffBatString: string = splitParts[1] || "0";
      const runsOffBat = parseInt(runsOffBatString, 10) || 0;
      const totalNbRuns = 1 + runsOffBat;

      battingTeam.totalRuns = Math.max(0, battingTeam.totalRuns - totalNbRuns);
      bowler.runsConceded = Math.max(0, bowler.runsConceded - totalNbRuns);

      // Find the specific historical batsman who faced it
      const facingBatsman = battingTeam.players.find(
        (p) => p.id === historicalBatsmanId,
      );
      if (facingBatsman) {
        facingBatsman.runsScored = Math.max(
          0,
          (facingBatsman.runsScored || 0) - runsOffBat,
        );
        facingBatsman.ballsFaced = Math.max(
          0,
          (facingBatsman.ballsFaced || 0) - 1,
        );
      }
    } else {
      // --- UNDO STANDARD BALL (0, 1, 2, 3, 4, 6) ---
      const runs = parseInt(lastBall, 10) || 0;

      battingTeam.totalRuns = Math.max(0, battingTeam.totalRuns - runs);
      bowler.runsConceded = Math.max(0, bowler.runsConceded - runs);
      battingTeam.ballsInCurrentOver = Math.max(
        0,
        battingTeam.ballsInCurrentOver - 1,
      );

      // Find the specific historical batsman who faced it
      const facingBatsman = battingTeam.players.find(
        (p) => p.id === historicalBatsmanId,
      );
      if (facingBatsman) {
        facingBatsman.runsScored = Math.max(
          0,
          (facingBatsman.runsScored || 0) - runs,
        );
        facingBatsman.ballsFaced = Math.max(
          0,
          (facingBatsman.ballsFaced || 0) - 1,
        );
      }
    }

    // Recalculate bowler economy
    const totalBowledBalls =
      bowler.oversBowled * 6 + battingTeam.ballsInCurrentOver;
    bowler.Economy =
      totalBowledBalls > 0
        ? parseFloat(((bowler.runsConceded / totalBowledBalls) * 6).toFixed(2))
        : 0.0;

    // 4. Save changes back down to Supabase
    const { error: updateError } = await supabase
      .from("matches")
      .update({ state: currentMatch })
      .eq("id", "live-match");

    if (updateError) {
      return res
        .status(500)
        .json({ error: "Failed to save data state changes." });
    }

    res.status(200).json(currentMatch);
  } catch (error) {
    console.error("Internal Server Error during match undo:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/api/players/create", async (req, res) => {
  try {
    const { name, image_url } = req.body;

    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "Player name is required." });
    }

    const newPlayer: { name: string; image_url?: string } = { name: name.trim() };
    if (typeof image_url === "string" && image_url.length > 0) {
      newPlayer.image_url = image_url;
    }

    const { data, error } = await supabase
      .from("players")
      .insert([newPlayer])
      .select()
      .single();

    if (error) {
      console.error("Create player insert failed:", error);
      return res
        .status(500)
        .json({ error: `Failed to save player to database: ${error.message}` });
    }

    return res.status(201).json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error during player registration." });
  }
});

// ==========================================
// 6. SELECT NEXT BOWLER ENDPOINT
// ==========================================
app.post("/api/match/next-bowler", async (req: Request, res: Response) => {
  const { playerId } = req.body;

  if (!playerId) {
    return res.status(400).json({ error: "Missing playerId in request body." });
  }

  try {
    const { data, error: fetchError } = await supabase
      .from("matches")
      .select("state")
      .eq("id", "live-match")
      .single();

    if (fetchError || !data) {
      return res.status(404).json({ error: "Match state not found." });
    }

    let currentMatch = data.state as MatchState;

    // Assign the new bowler to active duty
    currentMatch.currentBowlerId = playerId;

    const { error: updateError } = await supabase
      .from("matches")
      .update({ state: currentMatch, updated_at: new Date() })
      .eq("id", "live-match");

    if (updateError) {
      return res
        .status(500)
        .json({ error: "Failed to update new bowler in database." });
    }

    return res.status(200).json(currentMatch);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error setting next bowler." });
  }
});

// ==========================================
// 5. ADMIN: ADD PLAYER TO TEAM ON THE FLY
// ==========================================
app.post("/api/match/admin/add-player", async (req: Request, res: Response) => {
  const { teamKey, name } = req.body; // teamKey: "teamA" or "teamB", name: "New Player Name"

  if (!teamKey || !name) {
    return res
      .status(400)
      .json({ error: "Missing teamKey ('teamA' | 'teamB') or player name." });
  }

  try {
    // Fetch live match state
    const { data, error: fetchError } = await supabase
      .from("matches")
      .select("state")
      .eq("id", "live-match")
      .single();

    if (fetchError || !data) {
      return res.status(404).json({ error: "Live match state not found." });
    }

    let currentMatch = data.state as MatchState;

    // Validate team key safety
    if (teamKey !== "teamA" && teamKey !== "teamB") {
      return res
        .status(400)
        .json({ error: "Invalid team key. Must be 'teamA' or 'teamB'." });
    }

    const targetTeam = currentMatch[teamKey as "teamA" | "teamB"];

    // Create the fresh player object structure
    const newPlayer: Player = {
      id: `player_${Date.now()}`, // Generates a unique timestamped ID string
      name: name.trim(),
      runsScored: 0,
      ballsFaced: 0,
      fours: 0,
      sixes: 0,
      StrikeRate: 0,
      wicketsTaken: 0,
      oversBowled: 0,
      runsConceded: 0,
      wides: 0,
      dots: 0,
      deliveryHistory: [],
    };

    // Push into the team's array
    if (!targetTeam.players) {
      targetTeam.players = [];
    }
    targetTeam.players.push(newPlayer);

    // Save back to Supabase
    const { error: updateError } = await supabase
      .from("matches")
      .update({ state: currentMatch, updated_at: new Date() })
      .eq("id", "live-match");

    if (updateError) {
      return res
        .status(500)
        .json({ error: "Failed to save the new player to database." });
    }

    return res.status(200).json({
      message: `Successfully injected ${name} into ${targetTeam.name}!`,
      updatedMatchState: currentMatch,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server admin handler crashed." });
  }
});

// ==========================================
// 4. SELECT NEXT BATSMAN ENDPOINT
// ==========================================
app.post("/api/match/next-batsman", async (req: Request, res: Response) => {
  const { playerId, slot } = req.body; // slot will be "striker" or "nonStriker"

  if (!playerId) {
    return res.status(400).json({ error: "Missing playerId in request body." });
  }

  try {
    const { data, error: fetchError } = await supabase
      .from("matches")
      .select("state")
      .eq("id", "live-match")
      .single();

    if (fetchError || !data) {
      return res.status(404).json({ error: "Match state not found." });
    }

    let currentMatch = data.state as MatchState;

    // Assign the selected player to the requested slot safely
    if (slot === "striker") {
      currentMatch.strikerId = playerId;
    } else {
      currentMatch.nonStrikerId = playerId;
    }

    // Save the modified state back into Supabase
    const { error: updateError } = await supabase
      .from("matches")
      .update({ state: currentMatch, updated_at: new Date() })
      .eq("id", "live-match");

    if (updateError) {
      return res
        .status(500)
        .json({ error: "Failed to update new batsman in database." });
    }

    // Return the fresh match state back to the React Native app
    return res.status(200).json(currentMatch);
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: "Server error setting next batsman." });
  }
});


//-------------ADDING PLAYERS----------------
// 1. Fetch all global players for the dropdown/selection list
app.get("/api/players", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("players")
      .select("id, name, image_url")
      .order("name", { ascending: true });

    if (error) return res.status(500).json({ error: "Failed to fetch players pool." });
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: "Server error fetching players." });
  }
});

// Edit a global player (name and/or image)
app.put("/api/players/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, image_url } = req.body;

    const updates: { name?: string; image_url?: string | null } = {};
    if (typeof name === "string") {
      if (name.trim() === "") {
        return res.status(400).json({ error: "Player name cannot be empty." });
      }
      updates.name = name.trim();
    }
    // Allow clearing the image by sending image_url: null
    if (image_url !== undefined) {
      updates.image_url = image_url === null ? null : String(image_url);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Nothing to update." });
    }

    const { data, error } = await supabase
      .from("players")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("Update player failed:", error);
      return res.status(500).json({ error: `Failed to update player: ${error.message}` });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error updating player." });
  }
});

// Delete a global player
app.delete("/api/players/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase.from("players").delete().eq("id", id);

    if (error) {
      console.error("Delete player failed:", error);
      return res.status(500).json({ error: `Failed to delete player: ${error.message}` });
    }

    return res.status(200).json({ message: "Player deleted." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error deleting player." });
  }
});

// 2. Create a team with selected default players
app.post("/api/teams/create", async (req, res) => {
  try {
    const { name, playerIds } = req.body; // playerIds expected as array of strings: ["id1", "id2"]

    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "Team name is required." });
    }

    const { data, error } = await supabase
      .from("teams")
      .insert([{
        name: name.trim(),
        default_player_ids: playerIds || []
      }])
      .select()
      .single();

    if (error) {
      if (error.code === "23505") { // Unique violation error code in Postgres
        return res.status(400).json({ error: "A team with this name already exists." });
      }
      return res.status(500).json({ error: "Failed to create team." });
    }

    return res.status(201).json(data);
  } catch (error) {
    return res.status(500).json({ error: "Server error creating team." });
  }
});

// List all teams with standings (points table), best first
app.get("/api/teams", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("teams")
      .select("id, name, default_player_ids, played, won, lost, tied, points")
      .order("points", { ascending: false })
      .order("name", { ascending: true });

    if (error) return res.status(500).json({ error: "Failed to fetch teams." });
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: "Server error fetching teams." });
  }
});

// Delete a team
app.delete("/api/teams/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from("teams").delete().eq("id", id);

    if (error) {
      console.error("Delete team failed:", error);
      return res.status(500).json({ error: `Failed to delete team: ${error.message}` });
    }

    return res.status(200).json({ message: "Team deleted." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error deleting team." });
  }
});

// Update a team's name and/or roster (default_player_ids)
app.put("/api/teams/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, default_player_ids } = req.body;

    const updates: { name?: string; default_player_ids?: string[] } = {};
    if (typeof name === "string" && name.trim() !== "") {
      updates.name = name.trim();
    }
    if (Array.isArray(default_player_ids)) {
      updates.default_player_ids = default_player_ids;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Nothing to update." });
    }

    const { data, error } = await supabase
      .from("teams")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("Update team failed:", error);
      return res.status(500).json({ error: `Failed to update team: ${error.message}` });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error updating team." });
  }
});

// All completed matches (most recent first) for the Home history list
app.get("/api/match-history", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("match_history")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Fetch match history failed:", error);
      return res
        .status(500)
        .json({ error: `Failed to fetch match history: ${error.message}` });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error fetching match history." });
  }
});

// All completed matches a team played in (by id, with a name fallback)
app.get("/api/teams/:id/matches", async (req, res) => {
  try {
    const { id } = req.params;

    // Resolve the team name so we can also catch historical rows stored before
    // team ids were attributed.
    const { data: team } = await supabase
      .from("teams")
      .select("name")
      .eq("id", id)
      .single();

    let query = supabase
      .from("match_history")
      .select("*")
      .order("created_at", { ascending: false });

    if (team?.name) {
      query = query.or(
        `team_a_id.eq.${id},team_b_id.eq.${id},team_a_name.eq.${team.name},team_b_name.eq.${team.name}`,
      );
    } else {
      query = query.or(`team_a_id.eq.${id},team_b_id.eq.${id}`);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Fetch team matches failed:", error);
      return res.status(500).json({ error: `Failed to fetch team matches: ${error.message}` });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error fetching team matches." });
  }
});


app.post("/api/match/add-player-midmatch", async (req, res) => {
  try {
    const { teamKey, player } = req.body; // teamKey is 'teamA' or 'teamB', player is { id, name }

    if (!teamKey || !player || !player.id || !player.name) {
      return res.status(400).json({ error: "Missing teamKey or player structure details." });
    }

    // 1. Fetch the live match state
    const { data: matchData, error: matchError } = await supabase
      .from("matches")
      .select("state")
      .eq("id", "live-match")
      .single();

    if (matchError || !matchData) {
      return res.status(404).json({ error: "Cannot find live-match to modify." });
    }

    let currentMatch = matchData.state as MatchState;
    const targetTeam = currentMatch[teamKey as "teamA" | "teamB"];

    if (!targetTeam) {
      return res.status(400).json({ error: "Invalid team key provided." });
    }

    // Check if player is already inside the match state to avoid duplicates
    const existsInMatch = targetTeam.players.some((p) => p.id === player.id);
    if (!existsInMatch) {
      // Add player structure into the live match state
      targetTeam.players.push({
        id: player.id,
        name: player.name,
        runsScored: 0,
        ballsFaced: 0,
        fours: 0,
        sixes: 0,
        oversBowled: 0,
        runsConceded: 0,
        wicketsTaken: 0,
        Economy: 0.0,
        deliveryHistory: []
      });
    }

    // 2. Fetch the permanent team entity to update its default roster
    const teamName = targetTeam.name;
    const { data: teamData, error: teamFetchError } = await supabase
      .from("teams")
      .select("default_player_ids")
      .eq("name", teamName)
      .single();

    if (!teamFetchError && teamData) {
      let currentRoster: string[] = teamData.default_player_ids || [];
      if (!currentRoster.includes(player.id)) {
        currentRoster.push(player.id);

        // Update permanent team profile table
        await supabase
          .from("teams")
          .update({ default_player_ids: currentRoster })
          .eq("name", teamName);
      }
    }

    // 3. Sync everything back into the live match state row
    const { error: matchUpdateError } = await supabase
      .from("matches")
      .update({ state: currentMatch, updated_at: new Date() })
      .eq("id", "live-match");

    if (matchUpdateError) {
      return res.status(500).json({ error: "Failed to sync player additions to cloud state." });
    }

    return res.status(200).json(currentMatch);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server crashed processing midmatch roster addition." });
  }
});

// ==========================================
// SET TOTAL OVERS FOR THE MATCH
// ==========================================
app.post("/api/match/set-overs", async (req: Request, res: Response) => {
  const { totalOvers } = req.body;

  if (typeof totalOvers !== "number" || totalOvers < 1 || totalOvers > 50) {
    return res.status(400).json({ error: "totalOvers must be a number between 1 and 50." });
  }

  try {
    const { data, error: fetchError } = await supabase
      .from("matches")
      .select("state")
      .eq("id", "live-match")
      .single();

    if (fetchError || !data) {
      return res.status(404).json({ error: "Live match not found." });
    }

    let currentMatch = data.state as MatchState;
    currentMatch.totalOvers = totalOvers;

    const { error: updateError } = await supabase
      .from("matches")
      .update({ state: currentMatch, updated_at: new Date() })
      .eq("id", "live-match");

    if (updateError) {
      return res.status(500).json({ error: "Failed to save overs limit." });
    }

    return res.status(200).json(currentMatch);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error setting overs limit." });
  }
});

// ==========================================
// CREATE A NEW MATCH (RESET STATE)
// ==========================================
// Resolve (or create) a persistent team row, returning its id.
// - If an existing teamId is supplied (chose a saved team), reuse it untouched.
// - Otherwise upsert by name so "make new team" also lands in the teams list.
async function resolvePersistentTeam(
  name: string,
  playerIds: string[],
  providedId?: string,
): Promise<string | undefined> {
  if (providedId) return providedId;

  const cleanName = name.trim();

  const { data: existing } = await supabase
    .from("teams")
    .select("id")
    .eq("name", cleanName)
    .single();

  if (existing?.id) {
    // Refresh the roster of the matching team with this match's selection.
    await supabase
      .from("teams")
      .update({ default_player_ids: playerIds })
      .eq("id", existing.id);
    return existing.id;
  }

  const { data: created, error } = await supabase
    .from("teams")
    .insert([{ name: cleanName, default_player_ids: playerIds }])
    .select("id")
    .single();

  if (error) {
    console.error("resolvePersistentTeam insert failed:", error);
    return undefined;
  }
  return created?.id;
}

app.post("/api/match/create", async (req: Request, res: Response) => {
  const {
    teamAName,
    teamBName,
    teamAPlayerIds,
    teamBPlayerIds,
    totalOvers,
    teamAId,
    teamBId,
  } = req.body;

  if (!teamAName || !teamBName) {
    return res.status(400).json({ error: "Both team names are required." });
  }
  if (!Array.isArray(teamAPlayerIds) || !Array.isArray(teamBPlayerIds) || teamAPlayerIds.length === 0 || teamBPlayerIds.length === 0) {
    return res.status(400).json({ error: "Both teams must have players selected." });
  }
  if (typeof totalOvers !== "number" || totalOvers < 1 || totalOvers > 50) {
    return res.status(400).json({ error: "Overs must be a number between 1 and 50." });
  }

  try {
    const { data: dbPlayers, error: dbPlayersError } = await supabase
      .from("players")
      .select("id, name");

    if (dbPlayersError || !dbPlayers) {
      return res.status(500).json({ error: "Failed to fetch global players from database." });
    }

    const playerMap = new Map<string, string>(dbPlayers.map((p) => [p.id, p.name]));

    const buildRoster = (ids: string[]): Player[] => {
      return ids.map((id) => ({
        id,
        name: playerMap.get(id) || `Player ${id}`,
        runsScored: 0,
        ballsFaced: 0,
        fours: 0,
        sixes: 0,
        StrikeRate: 0,
        wicketsTaken: 0,
        oversBowled: 0,
        runsConceded: 0,
        wides: 0,
        dots: 0,
        deliveryHistory: [],
      }));
    };

    // Persist both teams (chosen or brand-new) so they appear in the teams list.
    const resolvedTeamAId = await resolvePersistentTeam(teamAName, teamAPlayerIds, teamAId);
    const resolvedTeamBId = await resolvePersistentTeam(teamBName, teamBPlayerIds, teamBId);

    const newMatch: MatchState = {
      teamA: {
        teamId: resolvedTeamAId,
        name: teamAName.trim(),
        totalRuns: 0,
        wicketsLost: 0,
        oversPlayed: 0,
        ballsInCurrentOver: 0,
        players: buildRoster(teamAPlayerIds),
        extras: 0,
        inningsComplete: false,
      },
      teamB: {
        teamId: resolvedTeamBId,
        name: teamBName.trim(),
        totalRuns: 0,
        wicketsLost: 0,
        oversPlayed: 0,
        ballsInCurrentOver: 0,
        players: buildRoster(teamBPlayerIds),
        extras: 0,
        inningsComplete: false,
      },
      currentInnings: "teamA",
      strikerId: null,
      nonStrikerId: null,
      currentBowlerId: null,
      totalOvers,
      resultRecorded: false,
    };

    const { error: updateError } = await supabase
      .from("matches")
      .update({ state: newMatch, updated_at: new Date() })
      .eq("id", "live-match");

    if (updateError) {
      return res.status(500).json({ error: "Failed to initialize new match in database." });
    }

    return res.status(200).json(newMatch);
  } catch (err) {
    console.error("Error creating match:", err);
    return res.status(500).json({ error: "Internal server error during match creation." });
  }
});

// ==========================================
// FINISH MATCH: award points + record history
// ==========================================
async function bumpTeamStanding(
  teamId: string | undefined,
  result: "won" | "lost" | "tied",
) {
  if (!teamId) return;

  const { data: team } = await supabase
    .from("teams")
    .select("played, won, lost, tied, points")
    .eq("id", teamId)
    .single();

  if (!team) return;

  const pointsFor = result === "won" ? 2 : result === "tied" ? 1 : 0;

  await supabase
    .from("teams")
    .update({
      played: (team.played || 0) + 1,
      won: (team.won || 0) + (result === "won" ? 1 : 0),
      lost: (team.lost || 0) + (result === "lost" ? 1 : 0),
      tied: (team.tied || 0) + (result === "tied" ? 1 : 0),
      points: (team.points || 0) + pointsFor,
    })
    .eq("id", teamId);
}

app.post("/api/match/finish", async (req: Request, res: Response) => {
  try {
    const { data, error: fetchError } = await supabase
      .from("matches")
      .select("state")
      .eq("id", "live-match")
      .single();

    if (fetchError || !data) {
      return res.status(404).json({ error: "Live match not found." });
    }

    const currentMatch = data.state as MatchState;
    const { teamA, teamB } = currentMatch;
    const target = currentMatch.target || teamA.totalRuns + 1;

    // Guard: only finish once the 2nd innings is actually decided.
    const chased = teamB.totalRuns >= target;
    const isComplete = chased || !!teamB.inningsComplete;
    if (!isComplete) {
      return res.status(400).json({ error: "Match is not complete yet." });
    }

    // Idempotency: never count the same match twice.
    if (currentMatch.resultRecorded) {
      return res
        .status(200)
        .json({ alreadyRecorded: true, resultText: (currentMatch as any).resultText || "" });
    }

    // Determine the outcome.
    let winnerId: string | undefined;
    let winnerName: string | null = null;
    let resultText: string;
    let aResult: "won" | "lost" | "tied";
    let bResult: "won" | "lost" | "tied";

    if (teamB.totalRuns > teamA.totalRuns) {
      const wicketsLeft = 10 - teamB.wicketsLost;
      winnerId = teamB.teamId;
      winnerName = teamB.name;
      resultText = `${teamB.name} won by ${wicketsLeft} wicket${wicketsLeft !== 1 ? "s" : ""}`;
      aResult = "lost";
      bResult = "won";
    } else if (teamB.totalRuns === teamA.totalRuns) {
      resultText = "Match tied";
      aResult = "tied";
      bResult = "tied";
    } else {
      const runsDiff = teamA.totalRuns - teamB.totalRuns;
      winnerId = teamA.teamId;
      winnerName = teamA.name;
      resultText = `${teamA.name} won by ${runsDiff} run${runsDiff !== 1 ? "s" : ""}`;
      aResult = "won";
      bResult = "lost";
    }

    // Record the completed match in history.
    const { error: histError } = await supabase.from("match_history").insert([
      {
        team_a_id: teamA.teamId || null,
        team_b_id: teamB.teamId || null,
        team_a_name: teamA.name,
        team_b_name: teamB.name,
        team_a_runs: teamA.totalRuns,
        team_a_wickets: teamA.wicketsLost,
        team_a_overs: `${teamA.oversPlayed}.${teamA.ballsInCurrentOver}`,
        team_b_runs: teamB.totalRuns,
        team_b_wickets: teamB.wicketsLost,
        team_b_overs: `${teamB.oversPlayed}.${teamB.ballsInCurrentOver}`,
        winner_id: winnerId || null,
        winner_name: winnerName,
        result_text: resultText,
        total_overs: currentMatch.totalOvers || null,
        state: currentMatch,
      },
    ]);

    if (histError) {
      console.error("match_history insert failed:", histError);
      return res
        .status(500)
        .json({ error: `Failed to record match history: ${histError.message}` });
    }

    // Award standings points (+2 win / +1 each tie / +0 loss).
    await bumpTeamStanding(teamA.teamId, aResult);
    await bumpTeamStanding(teamB.teamId, bResult);

    // Mark the live match so this can't double-count.
    (currentMatch as any).resultRecorded = true;
    (currentMatch as any).resultText = resultText;
    await supabase
      .from("matches")
      .update({ state: currentMatch, updated_at: new Date() })
      .eq("id", "live-match");

    return res.status(200).json({ resultText, winnerName });
  } catch (err) {
    console.error("Finish match error:", err);
    return res.status(500).json({ error: "Server error finishing match." });
  }
});

app.listen(PORT, () => {
  console.log(
    `[server]: Full-stack database server running on http://localhost:${PORT}`,
  );
});

