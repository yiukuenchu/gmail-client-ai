import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "~/server/auth";
import { MailIcon } from "lucide-react";

export default async function Home() {
  const session = await auth();

  if (session) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-blue-50 to-white">
      <div className="container flex flex-col items-center justify-center gap-12 px-4 py-16">
        <div className="flex items-center gap-4">
          <MailIcon className="w-16 h-16 text-blue-600" />
          <h1 className="text-5xl font-bold text-gray-900">Gmail Client</h1>
        </div>
        
        <p className="text-xl text-gray-600 text-center max-w-2xl">
          A modern Gmail client with AI-powered draft replies. Connect your Gmail account to get started.
        </p>

        <div className="flex flex-col gap-4 items-center">
          <Link
            href="/api/auth/signin"
            className="rounded-lg bg-blue-600 px-8 py-3 text-lg font-semibold text-white no-underline transition hover:bg-blue-700"
          >
            Sign in with Google
          </Link>
          
          <p className="text-sm text-gray-500">
            We'll request access to read and send emails on your behalf
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-12 max-w-4xl">
          <div className="text-center">
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mx-auto mb-4">
              <MailIcon className="w-6 h-6 text-blue-600" />
            </div>
            <h3 className="font-semibold text-gray-900 mb-2">Fast Sync</h3>
            <p className="text-sm text-gray-600">Sync hundreds of threads per minute with efficient batch processing</p>
          </div>
          
          <div className="text-center">
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-900 mb-2">AI Draft Replies</h3>
            <p className="text-sm text-gray-600">Generate intelligent email replies with AI assistance</p>
          </div>
          
          <div className="text-center">
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-900 mb-2">Powerful Search</h3>
            <p className="text-sm text-gray-600">Search through thousands of emails instantly</p>
          </div>
        </div>
      </div>
    </main>
  );
}