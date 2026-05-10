import dotenv from "dotenv";

dotenv.config();

import {
    runDropStateManager
} from "./jobs/dropStateManager.js";

async function startWorker() {

    console.log(
        "🚀 Running scheduled worker..."
    );

    await runDropStateManager();

    console.log(
        "✅ Worker completed"
    );

    process.exit(0);
}

startWorker();