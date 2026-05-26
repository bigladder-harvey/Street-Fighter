/* =========================================
   SETUP SCRIPT — RUN ONCE
   Registers your ShipStation label_purchased
   webhook so ShipStation notifies your
   backend when a label is bought.

   Usage:
   node scripts/setupShipStation.js
========================================= */

import "dotenv/config";
import { registerShipStationWebhook } from "../services/shipstation.js";

console.log("🚀 Registering ShipStation webhook...");

registerShipStationWebhook()
    .then(data => {
        console.log(
            "✅ Done:",
            JSON.stringify(data, null, 2)
        );
        process.exit(0);
    })
    .catch(err => {
        console.error(
            "❌ Failed:",
            err.message
        );
        process.exit(1);
    });