import { NextRequest, NextResponse } from "next/server";
import { db } from "~/server/db";
import { GmailSyncService } from "~/server/services/gmail-sync";

export const maxDuration = 60; // Maximum duration for Vercel

export async function POST(request: NextRequest) {
  try {
    // Verify authorization
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

    console.log(`🔄 Continuing sync for user ${userId}`);

    // Find incomplete sync job
    const incompleteSync = await db.syncJob.findFirst({
      where: {
        userId,
        status: "RUNNING",
      },
      orderBy: { startedAt: "desc" },
    });

    if (!incompleteSync) {
      return NextResponse.json({ error: "No incomplete sync found" }, { status: 404 });
    }

    // Create sync service and continue
    const syncService = await GmailSyncService.create(userId);
    if (!syncService) {
      await db.syncJob.update({
        where: { id: incompleteSync.id },
        data: { status: "FAILED", error: "No refresh token", completedAt: new Date() },
      });
      return NextResponse.json({ error: "Gmail not connected" }, { status: 401 });
    }

    // Continue the sync from where it left off
    await syncService.syncMailbox(incompleteSync.type, incompleteSync.id);

    return NextResponse.json({
      message: "Sync continued",
      processedItems: incompleteSync.processedItems,
      totalItems: incompleteSync.totalItems,
    });

  } catch (error) {
    console.error("Continue sync failed:", error);
    return NextResponse.json(
      { 
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error" 
      },
      { status: 500 }
    );
  }
}