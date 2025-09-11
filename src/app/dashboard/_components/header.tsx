"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SearchIcon, UserCircleIcon, LogOutIcon } from "lucide-react";
import { signOut } from "next-auth/react";
import { useSession } from "next-auth/react";

export function Header() {
  const [searchQuery, setSearchQuery] = useState("");
  const router = useRouter();
  const { data: session } = useSession();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.push(`/dashboard/search?q=${encodeURIComponent(searchQuery)}`);
    }
  };

  return (
    <header className="bg-white border-b border-gray-200 px-6 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center flex-1">
          <h1 className="text-2xl font-semibold text-gray-800">Gmail</h1>
          
          <form onSubmit={handleSearch} className="ml-8 flex-1 max-w-2xl">
            <div className="relative">
              <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search mail"
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </form>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            {session?.user?.image ? (
              <img
                src={session.user.image}
                alt={session.user.name ?? "User"}
                className="w-8 h-8 rounded-full"
              />
            ) : (
              <UserCircleIcon className="w-8 h-8 text-gray-400" />
            )}
            <span className="text-sm text-gray-700">{session?.user?.email}</span>
          </div>
          
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="text-gray-500 hover:text-gray-700 transition-colors"
            title="Sign out"
          >
            <LogOutIcon className="w-5 h-5" />
          </button>
        </div>
      </div>
    </header>
  );
}