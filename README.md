# Gmail Client with AI Draft Replies

A modern Gmail client built with Next.js, featuring AI-powered draft replies, advanced search, email composition, and intelligent email synchronization.

## Features

### Core Email Functionality
- **Gmail OAuth Integration**: Secure login with your Gmail account
- **Fast Email Sync**: Batch processing of 400-500 threads per minute with idle user detection
- **Infinite Scroll**: Smooth browsing of 10k+ email threads
- **Thread Management**: Proper email threading with replies and forwards

### Email Composition & Management  
- **Compose New Emails**: Full-featured email composer with Gmail-style interface
- **Forward Messages**: Forward emails with original content and proper formatting
- **Reply Functionality**: Smart reply with auto-scroll and recipient pre-fill
- **Attachment Support**: Upload, send, and download attachments with S3 storage
- **MIME Multipart**: Proper email formatting with attachment support

### Advanced Search & AI
- **Advanced Search**: Multi-criteria search with date ranges, status filters, and content search
- **Full-Text Search**: Search across subjects, senders, recipients, and message content  
- **AI Draft Replies**: Generate intelligent email replies using Google Gemini
- **Smart Filtering**: Filter by read/unread, starred, important, and attachment status

### Performance & UX
- **Raycast Design System**: Consistent, polished UI components
- **Real-time Sync**: Scheduled daily sync jobs optimized for active users
- **Multiple Sync Prevention**: Frontend and backend protection against concurrent syncs
- **Smart Cron Jobs**: Only sync active users to optimize resources

## Tech Stack

- **Framework**: Next.js 15 with App Router
- **Database**: PostgreSQL with Prisma ORM
- **Authentication**: NextAuth.js with Google OAuth
- **API**: tRPC for type-safe API calls
- **Storage**: AWS S3 for email content and attachments
- **UI**: Raycast Design System with Tailwind CSS
- **AI**: Google Gemini API for draft generation
- **Email Processing**: MIME multipart for attachments, Gmail API integration
- **Deployment**: Vercel with automated cron jobs

## Setup Instructions

### 1. Clone and Install

```bash
git clone <repo-url>
cd gmail-app
npm install
```

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

Required environment variables:

#### Authentication

- `AUTH_SECRET`: Generate with `npx auth secret`
- `AUTH_GOOGLE_ID`: Google OAuth client ID
- `AUTH_GOOGLE_SECRET`: Google OAuth client secret

#### Database

- `DATABASE_URL`: PostgreSQL connection string

#### AWS S3

- `AWS_REGION`: AWS region (e.g., us-east-1)
- `AWS_ACCESS_KEY_ID`: AWS access key
- `AWS_SECRET_ACCESS_KEY`: AWS secret key
- `S3_BUCKET_NAME`: S3 bucket name for storing emails

#### AI Integration (Optional)

- `GOOGLE_GEMINI_API_KEY`: Get from [Google AI Studio](https://makersuite.google.com/app/apikey)

#### Deployment

- `CRON_SECRET`: Random string for securing cron endpoints

### 3. Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable Gmail API and Google+ API
4. Go to "Credentials" and create OAuth 2.0 Client IDs
5. Add authorized redirect URI: `https://yourdomain.com/api/auth/callback/google`
6. Add the following scopes in OAuth consent screen:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/gmail.modify`

### 4. Database Setup

```bash
# Push the schema to your database
npm run db:push

# Or run migrations
npm run db:generate
```

### 5. AWS S3 Setup

1. Create an S3 bucket in your AWS account
2. Create an IAM user with S3 permissions
3. Add the bucket name and credentials to your `.env` file

### 6. Run Development Server

```bash
npm run dev
```

Visit `http://localhost:3000` to see the application.

## Deployment to Vercel

1. Push your code to GitHub
2. Connect your GitHub repo to Vercel
3. Add all environment variables in Vercel dashboard
4. The `vercel.json` file is already configured for cron jobs
5. Deploy!

### Vercel Environment Variables

Make sure to add these in your Vercel project settings:

- All variables from `.env.example`
- **Important**: Set `CRON_SECRET` as a regular environment variable (not a Vercel secret)

### Verifying Cron Job Setup

After deployment, verify your cron job is working:

1. **Check Function Logs**: Vercel Dashboard → Your Project → Functions → Look for `/api/cron/sync`
2. **Monitor Execution**: Logs will show daily executions at midnight UTC
3. **Verify Response**: Should see "Sync started for X active users" with detailed stats
4. **Manual Test**: Test the endpoint with your CRON_SECRET to verify authentication

## Usage

### First Time Setup

1. Sign in with your Google account
2. Grant permission for Gmail access
3. Click "Sync Mail" to start the initial synchronization
4. Wait for the sync to complete (progress shown in sidebar)

### Daily Usage

#### Email Management
- **Reading Emails**: Browse threads in the main interface with infinite scroll
- **Replying**: Click "Reply" button or use reply box - automatically scrolls to compose area
- **Composing**: Use "Compose" button for new emails with full recipient management
- **Forwarding**: Click "Forward" on any message to send to others with original content
- **Attachments**: Upload files when composing, download from received messages

#### Search & Navigation  
- **Basic Search**: Use the search bar for quick text searches
- **Advanced Search**: Click filter icon for multi-criteria search with date ranges, status filters
- **Smart Filtering**: Filter by read/unread, starred, important messages
- **Thread Actions**: Star messages, navigate with consistent UI

#### AI Features
- **AI Drafts**: Click "Draft with AI" to generate intelligent replies based on thread context
- **Smart Composition**: Get contextual help for email writing

### Sync Schedule

- **Manual Sync**: Available anytime via "Sync Mail" button (with rate limiting protection)
- **Automatic Sync**: Runs daily at midnight UTC via Vercel cron jobs
- **Smart Scheduling**: Only syncs active users (those with valid sessions) to optimize resources
- **Sync Types**: Initial sync processes all emails; subsequent syncs are incremental batch processing
- **Multiple Sync Prevention**: Frontend and backend protection prevents concurrent sync attempts

## API Endpoints

### tRPC Routes

#### Email Management
- `gmail.getThreads` - Paginated thread listing with advanced search filters
- `gmail.getThread` - Single thread with all messages and attachments
- `gmail.getMessageContent` - Full message content with HTML/text support
- `gmail.getAttachmentUrl` - Secure S3 presigned URLs for downloads

#### Email Operations  
- `gmail.sendReply` - Send emails and replies with attachment support
- `gmail.uploadAttachment` - Upload files to S3 for email composition
- `gmail.generateAIDraft` - Generate AI-powered drafts with thread context

#### Search & Sync
- `gmail.searchThreads` - Full-text search across all content
- `gmail.syncMailbox` - Trigger full manual sync
- `gmail.syncBatch` - Batch processing sync with mutex protection
- `gmail.getSyncStatus` - Real-time sync progress and status
- `gmail.toggleStar` - Star/unstar threads with optimistic updates

### Cron Jobs

- `/api/cron/sync` - Scheduled email synchronization (daily at midnight UTC)
  - Filters for active users only (valid sessions)
  - Processes up to 5 users per run for optimal resource usage
  - Includes detailed stats and error handling

## Performance Optimizations

### Frontend Performance
- **Infinite Scroll**: Virtual scrolling for 10k+ threads
- **Optimistic Updates**: Immediate UI feedback for starring and actions
- **Rate Limiting**: Frontend sync protection prevents multiple concurrent requests
- **Raycast Design System**: Consistent, lightweight UI components

### Backend Performance  
- **Database Indexing**: Optimized indexes for threads, messages, and search
- **S3 Storage**: Email content and attachments stored in S3 for fast access
- **Batch Processing**: Efficient sync with concurrent processing (20-100 threads per batch)
- **Connection Pooling**: Optimized database connections with proper cleanup
- **Idle User Detection**: Cron jobs only sync active users to conserve resources
- **Mutex Protection**: Database-level sync prevention for race condition safety

### Email Processing
- **MIME Multipart**: Proper email formatting with attachment support
- **Bulk Operations**: Batch database inserts for improved sync performance
- **S3 Presigned URLs**: Secure, direct attachment downloads
- **Attachment Batching**: Optimized file upload and processing

## Security Features

### Authentication & Authorization
- **OAuth 2.0**: Secure authentication with Google Gmail API
- **Server-side Token Management**: Secure refresh token storage and rotation
- **Session-based Access Control**: User isolation and permission validation

### Data Security
- **S3 Presigned URLs**: Secure, time-limited attachment downloads
- **Input Validation**: Comprehensive validation and sanitization with Zod schemas
- **Email Validation**: Frontend and backend email address validation
- **CSRF Protection**: Built-in protection against cross-site request forgery

### Operational Security  
- **Cron Job Authentication**: Bearer token protection for scheduled endpoints
- **Multiple Sync Prevention**: Database-level mutex and frontend rate limiting
- **Error Handling**: Secure error messages without information leakage
- **Environment Variable Management**: Secure configuration with Vercel environment variables

## Development

### Database

```bash
# View data
npm run db:studio

# Reset database
npm run db:push --force-reset

# Generate Prisma client
npx prisma generate
```

### Type Checking

```bash
npm run typecheck
```

### Building

```bash
npm run build
npm run start
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details.
