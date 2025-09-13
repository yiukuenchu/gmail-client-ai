import { type gmail_v1 } from 'googleapis';
import { db } from '../db';
import {
  getGmailClient,
  getUserRefreshToken,
  extractEmailContent,
  getHeaderValue,
  parseEmailAddresses,
  type GmailThread,
  type GmailMessage,
  type GmailLabel,
} from '../gmail';
import { uploadToS3, S3_PATHS } from '../s3';
import { type JobStatus, type SyncType } from '@prisma/client';

const BATCH_SIZE = 10; // Reduced to prevent connection pool exhaustion
const THREADS_PER_PAGE = 50; // Smaller pages for production
const MAX_CONCURRENT_BATCHES = 1; // Sequential processing to minimize connections

export class GmailSyncService {
  private gmail: gmail_v1.Gmail;
  private userId: string;
  private syncJobId: string | null = null;

  constructor(gmail: gmail_v1.Gmail, userId: string) {
    this.gmail = gmail;
    this.userId = userId;
  }

  static async create(userId: string): Promise<GmailSyncService | null> {
    const refreshToken = await getUserRefreshToken(userId);
    if (!refreshToken) return null;

    const gmail = getGmailClient(refreshToken);
    return new GmailSyncService(gmail, userId);
  }

  async syncMailbox(
    syncType: SyncType = 'FULL',
    resumeFromJobId?: string
  ): Promise<void> {
    try {
      let syncJob;
      let isResuming = false;

      if (resumeFromJobId) {
        // Resume existing job
        syncJob = await db.syncJob.findUnique({
          where: { id: resumeFromJobId },
        });

        if (!syncJob || syncJob.status !== 'RUNNING') {
          throw new Error('Invalid or completed sync job for resume');
        }

        this.syncJobId = syncJob.id;
        isResuming = true;
        console.log(
          `📂 Resuming sync job ${syncJob.id} from page token: ${
            syncJob.nextPageToken ? 'yes' : 'start'
          }`
        );
      } else {
        // Create new sync job
        syncJob = await db.syncJob.create({
          data: {
            userId: this.userId,
            status: 'RUNNING',
            type: syncType,
          },
        });
        this.syncJobId = syncJob.id;
      }

      // Update user sync status and show initial progress
      await db.user.update({
        where: { id: this.userId },
        data: { syncStatus: 'SYNCING' },
      });

      // Show 1% progress immediately for production visibility
      if (!isResuming) {
        await this.updateSyncProgress(1, 100);

        // Sync labels first (skip if resuming)
        await this.syncLabels();

        // Show 3% progress after labels
        await this.updateSyncProgress(3, 100);
      }

      // Sync threads (will resume from saved state if applicable)
      console.log('📋 Starting thread sync phase');
      await this.syncThreads(isResuming ? syncJob : null);
      console.log('📋 Thread sync phase completed');

      // Mark sync as completed
      console.log('🏁 Marking sync job as completed');
      await this.completeSyncJob('COMPLETED');

      await db.user.update({
        where: { id: this.userId },
        data: {
          syncStatus: 'COMPLETED',
          lastSyncedAt: new Date(),
        },
      });
    } catch (error) {
      console.error('Sync failed:', error);

      // Enhanced error logging for production
      if (error instanceof Error) {
        console.error('Error details:', {
          name: error.name,
          message: error.message,
          stack:
            process.env.NODE_ENV === 'development' ? error.stack : undefined,
          userId: this.userId,
          syncJobId: this.syncJobId,
        });
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      await this.completeSyncJob('FAILED', errorMessage);

      await db.user.update({
        where: { id: this.userId },
        data: { syncStatus: 'FAILED' },
      });

      throw error;
    }
  }

  private async completeSyncJob(
    status: JobStatus,
    error?: string
  ): Promise<void> {
    if (!this.syncJobId) return;

    await db.syncJob.update({
      where: { id: this.syncJobId },
      data: {
        status,
        completedAt: new Date(),
        progress: status === 'COMPLETED' ? 100 : undefined,
        nextPageToken: null, // Clear token when job completes
        error,
      },
    });
  }

  private async updateSyncProgress(
    processedItems: number,
    totalItems: number
  ): Promise<void> {
    if (!this.syncJobId) return;

    // Fix: Ensure progress never exceeds 100% and handle estimates
    const actualTotal = Math.max(totalItems, processedItems); // Use actual count if estimate is wrong
    const progress =
      actualTotal > 0 ? Math.min((processedItems / actualTotal) * 100, 100) : 0;

    await db.syncJob.update({
      where: { id: this.syncJobId },
      data: {
        processedItems,
        totalItems: actualTotal, // Update with actual total
        progress: Math.round(progress), // Round to avoid decimals
      },
    });
  }

  private async syncLabels(): Promise<void> {
    const response = await this.gmail.users.labels.list({ userId: 'me' });
    const labels = (response.data.labels as GmailLabel[]) || [];

    for (const label of labels) {
      await db.label.upsert({
        where: {
          userId_gmailLabelId: {
            userId: this.userId,
            gmailLabelId: label.id,
          },
        },
        update: {
          name: label.name,
          type: label.type === 'system' ? 'SYSTEM' : 'USER',
          color: label.color?.backgroundColor,
          messageListVisibility: label.messageListVisibility,
          labelListVisibility: label.labelListVisibility,
        },
        create: {
          userId: this.userId,
          gmailLabelId: label.id,
          name: label.name,
          type: label.type === 'system' ? 'SYSTEM' : 'USER',
          color: label.color?.backgroundColor,
          messageListVisibility: label.messageListVisibility,
          labelListVisibility: label.labelListVisibility,
        },
      });
    }
  }

  private async syncThreads(resumeFromJob?: any): Promise<void> {
    let pageToken: string | undefined;
    let totalThreads = 0;
    let processedThreads = 0;
    const startTime = Date.now();
    const PRODUCTION_TIMEOUT = 280000; // 280 seconds - safe margin for 300s Vercel limit

    // Resume from saved state if available
    if (resumeFromJob?.nextPageToken) {
      pageToken = resumeFromJob.nextPageToken;
      processedThreads = resumeFromJob.processedItems || 0;
      totalThreads = resumeFromJob.totalItems || 0;
      console.log(
        `🔄 Resuming thread sync from page token, already processed: ${processedThreads}/${totalThreads}`
      );
    } else {
      console.log('🔄 Starting thread sync...');
    }

    do {
      // Check timeout before each page (only in production)
      if (process.env.NODE_ENV === 'production') {
        const elapsedTime = Date.now() - startTime;
        if (elapsedTime > PRODUCTION_TIMEOUT) {
          console.log(
            `⏰ PRODUCTION TIMEOUT: Processed ${processedThreads}/${totalThreads} threads in ${elapsedTime}ms`
          );
          console.log(`💾 Saving progress and exiting gracefully`);

          // Schedule continuation if there's more work
          if (pageToken && this.syncJobId) {
            console.log(`🔄 Scheduling automatic continuation...`);
            // In production, you could trigger a webhook or use a job queue here
            // For now, we'll just exit and let the user manually continue
          }

          return; // Exit gracefully before Vercel kills us
        }
      }

      // Fetch threads page
      const response = await this.gmail.users.threads.list({
        userId: 'me',
        maxResults: THREADS_PER_PAGE,
        pageToken,
      });

      const threads = response.data.threads || [];
      // Update total with actual count as we discover more threads
      const currentEstimate = response.data.resultSizeEstimate || 0;
      totalThreads = Math.max(
        totalThreads,
        currentEstimate,
        processedThreads + threads.length
      );

      console.log(
        `📧 Processing page: ${threads.length} threads (total estimate: ${totalThreads}, processed: ${processedThreads})`
      );

      // Process threads in batches
      for (let i = 0; i < threads.length; i += BATCH_SIZE) {
        const batch = threads.slice(i, i + BATCH_SIZE);

        // Process batch sequentially to avoid connection pool exhaustion
        for (const thread of batch) {
          await this.syncThread(thread.id!);

          // Small delay in production to prevent connection pool exhaustion
          if (process.env.NODE_ENV === 'production') {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }

        processedThreads += batch.length;
        await this.updateSyncProgress(processedThreads, totalThreads);

        // Log progress more frequently for debugging
        if (processedThreads % 10 === 0 || processedThreads === totalThreads) {
          const elapsedTime = Date.now() - startTime;
          console.log(
            `⚡ Processed ${processedThreads}/${totalThreads} threads (${Math.round(
              elapsedTime / 1000
            )}s elapsed)`
          );
        }
      }

      pageToken = response.data.nextPageToken ?? undefined;

      // Save progress after each page for resumability
      if (this.syncJobId) {
        await db.syncJob.update({
          where: { id: this.syncJobId },
          data: {
            nextPageToken: pageToken || null,
            processedItems: processedThreads,
            totalItems: totalThreads,
            progress: Math.round((processedThreads / totalThreads) * 100),
          },
        });
        console.log(
          `💾 Saved sync progress: ${processedThreads}/${totalThreads} threads, nextPageToken: ${
            pageToken ? 'yes' : 'complete'
          }`
        );
      }
    } while (pageToken);

    const totalElapsed = Date.now() - startTime;
    console.log(
      `✅ Thread sync completed: ${processedThreads} threads processed in ${Math.round(
        totalElapsed / 1000
      )}s`
    );
  }

  private async syncThread(
    gmailThreadId: string,
    retryCount = 0
  ): Promise<void> {
    try {
      // Fetch full thread data
      const response = await this.gmail.users.threads.get({
        userId: 'me',
        id: gmailThreadId,
      });

      const threadData = response.data;
      if (!threadData.messages || threadData.messages.length === 0) return;

      // Get thread metadata from the last message
      const lastMessage = threadData.messages[
        threadData.messages.length - 1
      ] as GmailMessage;
      const firstMessage = threadData.messages[0] as GmailMessage;

      const subject =
        getHeaderValue(lastMessage.payload.headers, 'Subject') ||
        getHeaderValue(firstMessage.payload.headers, 'Subject') ||
        '(no subject)';

      // Check for INBOX label to determine if unread
      const hasInbox = lastMessage.labelIds?.includes('INBOX') ?? false;
      const isUnread = lastMessage.labelIds?.includes('UNREAD') ?? false;
      const isStarred = lastMessage.labelIds?.includes('STARRED') ?? false;
      const isImportant = lastMessage.labelIds?.includes('IMPORTANT') ?? false;

      // Upsert thread
      const thread = await db.thread.upsert({
        where: {
          userId_gmailThreadId: {
            userId: this.userId,
            gmailThreadId,
          },
        },
        update: {
          subject,
          snippet: threadData.snippet || '',
          lastMessageDate: new Date(parseInt(lastMessage.internalDate)),
          unread: isUnread,
          starred: isStarred,
          important: isImportant,
          messageCount: threadData.messages.length,
        },
        create: {
          userId: this.userId,
          gmailThreadId,
          subject,
          snippet: threadData.snippet || '',
          lastMessageDate: new Date(parseInt(lastMessage.internalDate)),
          unread: isUnread,
          starred: isStarred,
          important: isImportant,
          messageCount: threadData.messages.length,
        },
      });

      // Sync all messages in the thread
      for (const message of threadData.messages as GmailMessage[]) {
        await this.syncMessage(message, thread.id);
      }

      // Sync thread labels
      await this.syncThreadLabels(thread.id, lastMessage.labelIds || []);
    } catch (error) {
      console.error(`Failed to sync thread ${gmailThreadId}:`, error);

      // Handle connection pool errors with retry
      if (
        error instanceof Error &&
        error.message.includes('connection pool') &&
        retryCount < 3
      ) {
        console.log(
          `Retrying thread ${gmailThreadId} after connection pool error (attempt ${
            retryCount + 1
          }/3)`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (retryCount + 1))
        ); // Exponential backoff
        return this.syncThread(gmailThreadId, retryCount + 1);
      }

      // Re-throw to stop sync on critical errors
      if (error instanceof Error && error.message.includes('connection')) {
        throw error;
      }
    }
  }

  private async syncMessage(
    message: GmailMessage,
    threadId: string
  ): Promise<void> {
    const headers = message.payload.headers;
    const from = getHeaderValue(headers, 'From');
    const to = parseEmailAddresses(getHeaderValue(headers, 'To'));
    const cc = parseEmailAddresses(getHeaderValue(headers, 'Cc'));
    const bcc = parseEmailAddresses(getHeaderValue(headers, 'Bcc'));
    const subject = getHeaderValue(headers, 'Subject') || '(no subject)';
    const date = new Date(parseInt(message.internalDate));
    const inReplyTo = getHeaderValue(headers, 'In-Reply-To') || null;
    const references = parseEmailAddresses(
      getHeaderValue(headers, 'References')
    );

    // Extract content
    const { html, text, attachments } = extractEmailContent(message);

    // Upload HTML to S3
    let htmlS3Key: string | null = null;
    if (html) {
      htmlS3Key = S3_PATHS.MESSAGE_HTML(this.userId, message.id);
      await uploadToS3(htmlS3Key, html, 'text/html');
    }

    // Upsert message
    const savedMessage = await db.message.upsert({
      where: {
        gmailMessageId: message.id,
      },
      update: {
        snippet: message.snippet,
        htmlS3Key,
        textContent: text,
        labelIds: message.labelIds || [],
      },
      create: {
        threadId,
        gmailMessageId: message.id,
        gmailThreadId: message.threadId,
        from,
        to,
        cc,
        bcc,
        subject,
        snippet: message.snippet,
        date,
        htmlS3Key,
        textContent: text,
        inReplyTo,
        references,
        labelIds: message.labelIds || [],
      },
    });

    // Sync attachments
    for (const attachment of attachments) {
      await this.syncAttachment(savedMessage.id, message.id, attachment);
    }
  }

  private async syncAttachment(
    messageId: string,
    gmailMessageId: string,
    attachment: {
      filename: string;
      mimeType: string;
      attachmentId: string;
      size: number;
    }
  ): Promise<void> {
    // Check if attachment already exists
    const existing = await db.attachment.findFirst({
      where: {
        messageId,
        gmailAttachmentId: attachment.attachmentId,
      },
    });

    if (existing) return;

    // Download attachment
    const response = await this.gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: gmailMessageId,
      id: attachment.attachmentId,
    });

    if (!response.data.data) return;

    // Upload to S3
    const s3Key = S3_PATHS.ATTACHMENT(
      this.userId,
      gmailMessageId,
      attachment.attachmentId,
      attachment.filename
    );

    const attachmentData = Buffer.from(response.data.data, 'base64');
    await uploadToS3(s3Key, attachmentData, attachment.mimeType);

    // Save to database
    await db.attachment.create({
      data: {
        messageId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        s3Key,
        gmailAttachmentId: attachment.attachmentId,
      },
    });
  }

  private async syncThreadLabels(
    threadId: string,
    labelIds: string[]
  ): Promise<void> {
    // Remove existing label associations
    await db.labelThread.deleteMany({
      where: { threadId },
    });

    // Add new label associations
    const labels = await db.label.findMany({
      where: {
        userId: this.userId,
        gmailLabelId: { in: labelIds },
      },
    });

    for (const label of labels) {
      await db.labelThread.create({
        data: {
          labelId: label.id,
          threadId,
        },
      });
    }
  }
}
