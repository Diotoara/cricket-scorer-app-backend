import { supabase } from "./supabase";

async function runCheck() {
  const testColumns = ["imageUrl", "image", "avatar", "avatarUrl", "photo", "photoUrl"];
  
  for (const col of testColumns) {
    const { data, error } = await supabase
      .from("players")
      .select(`id, name, ${col}`)
      .limit(1);

    if (error) {
      console.log(`Column '${col}' does NOT exist (Error: ${error.message})`);
    } else {
      console.log(`Column '${col}' EXISTS!`);
    }
  }
}

runCheck();
