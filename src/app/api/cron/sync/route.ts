import { NextRequest, NextResponse } from "next/server";
import { db } from "~/server/db";
import { GmailSyncService } from "~/server/services/gmail-sync";

export async function GET(request: NextRequest) {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Find users who need sync (last synced > 1 hour ago or never synced)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    const usersToSync = await db.user.findMany({
      where: {
        OR: [
          { lastSyncedAt: null },
          { lastSyncedAt: { lt: oneHourAgo } },
        ],
        syncStatus: { not: "SYNCING" }, // Don't sync if already syncing
      },
      take: 10, // Limit concurrent syncs
    });

    const syncResults = [];

    for (const user of usersToSync) {
      try {
        const syncService = await GmailSyncService.create(user.id);
        if (syncService) {
          // Start sync in background
          void syncService.syncMailbox("PARTIAL");
          syncResults.push({ userId: user.id, status: "started" });
        } else {
          syncResults.push({ userId: user.id, status: "no_token" });
        }
      } catch (error) {
        console.error(`Failed to start sync for user ${user.id}:`, error);
        syncResults.push({ 
          userId: user.id, 
          status: "error", 
          error: error instanceof Error ? error.message : "Unknown error" 
        });
      }
    }

    return NextResponse.json({
      message: `Sync started for ${syncResults.filter(r => r.status === "started").length} users`,
      results: syncResults,
    });
  } catch (error) {
    console.error("Cron sync failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}