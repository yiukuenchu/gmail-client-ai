"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SearchIcon, UserCircleIcon, LogOutIcon, FilterIcon } from "lucide-react";
import { signOut } from "next-auth/react";
import { useSession } from "next-auth/react";
import { AdvancedSearch } from "./advanced-search";

export function Header() {
  const [searchQuery, setSearchQuery] = useState("");
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const router = useRouter();
  const { data: session } = useSession();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.push(`/dashboard/search?q=${encodeURIComponent(searchQuery)}`);
    }
  };

  return (
    <header className="px-6 py-4" style={{ 
      backgroundColor: 'var(--color-raycast-surface)', 
      borderBottom: '1px solid var(--color-raycast-border-light)' 
    }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center flex-1">
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--color-raycast-text)' }}>
            Gmail
          </h1>
          
          <div className="ml-8 flex-1 max-w-2xl flex items-center">
            <form onSubmit={handleSearch} className="flex-1">
              <div className="raycast-search" style={{ maxWidth: 'none' }}>
                <SearchIcon className="raycast-search-icon w-5 h-5" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search mail"
                  className="raycast-search-input"
                />
              </div>
            </form>
            <button
              onClick={() => setShowAdvancedSearch(true)}
              className="raycast-button p-2 ml-2"
              title="Advanced Search"
            >
              <FilterIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg" style={{ 
            backgroundColor: 'var(--color-raycast-bg-tertiary)' 
          }}>
            {session?.user?.image ? (
              <img
                src={session.user.image}
                alt={session.user.name ?? "User"}
                className="w-7 h-7 rounded-full"
              />
            ) : (
              <UserCircleIcon className="w-7 h-7" style={{ color: 'var(--color-raycast-text-secondary)' }} />
            )}
            <span className="text-sm font-medium" style={{ color: 'var(--color-raycast-text)' }}>
              {session?.user?.email}
            </span>
          </div>
          
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="raycast-button p-2"
            title="Sign out"
          >
            <LogOutIcon className="w-5 h-5" />
          </button>
        </div>
      </div>
      
      <AdvancedSearch
        isOpen={showAdvancedSearch}
        onClose={() => setShowAdvancedSearch(false)}
        initialQuery={searchQuery}
      />
    </header>
  );
}