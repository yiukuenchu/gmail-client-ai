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

    // Find users who need sync (last synced > 23 hours ago or never synced)
    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000);
    
    const usersToSync = await db.user.findMany({
      where: {
        AND: [
          // Need sync
          {
            OR: [
              { lastSyncedAt: null },
              { lastSyncedAt: { lt: twentyThreeHoursAgo } },
            ],
          },
          // Not currently syncing
          { syncStatus: { not: "SYNCING" } },
          // Has active sessions (user has logged in recently)
          {
            sessions: {
              some: {
                expires: { gt: new Date() }, // Session not expired
              },
            },
          },
        ],
      },
      include: {
        sessions: {
          where: { expires: { gt: new Date() } },
          orderBy: { expires: "desc" },
          take: 1,
        },
      },
      // Order by most recently active users first
      orderBy: [
        { lastSyncedAt: "asc" }, // Prioritize never-synced users
      ],
      take: 5, // Reduced from 10 since we're being more selective
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

    const startedCount = syncResults.filter(r => r.status === "started").length;
    
    return NextResponse.json({
      message: `Sync started for ${startedCount} active users`,
      results: syncResults,
      stats: {
        activeUsersFound: usersToSync.length,
        syncStarted: startedCount,
        syncFailed: syncResults.filter(r => r.status === "error").length,
        noTokenUsers: syncResults.filter(r => r.status === "no_token").length,
      },
    });
  } catch (error) {
    console.error("Cron sync failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}