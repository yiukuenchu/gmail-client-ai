"use client";

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { api } from "~/trpc/react";
import { ThreadList } from "../_components/thread-list";

export default function SearchPage() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") || "";
  const advancedParam = searchParams.get("advanced");
  
  const { searchQuery, advancedSearch, searchTitle } = useMemo(() => {
    let parsedAdvanced = null;
    let title = "";
    
    if (advancedParam) {
      try {
        parsedAdvanced = JSON.parse(advancedParam);
        
        // Convert date strings to Date objects
        if (parsedAdvanced.dateAfter) {
          parsedAdvanced.dateAfter = new Date(parsedAdvanced.dateAfter);
        }
        if (parsedAdvanced.dateBefore) {
          parsedAdvanced.dateBefore = new Date(parsedAdvanced.dateBefore);
        }
        
        // Build a descriptive title for advanced search
        const filters = [];
        if (parsedAdvanced.subject) filters.push(`subject:"${parsedAdvanced.subject}"`);
        if (parsedAdvanced.from) filters.push(`from:"${parsedAdvanced.from}"`);
        if (parsedAdvanced.to) filters.push(`to:"${parsedAdvanced.to}"`);
        if (parsedAdvanced.content) filters.push(`content:"${parsedAdvanced.content}"`);
        if (parsedAdvanced.dateRange) filters.push(`${parsedAdvanced.dateRange}`);
        if (parsedAdvanced.hasAttachments) filters.push("has:attachments");
        if (parsedAdvanced.isStarred) filters.push("is:starred");
        if (parsedAdvanced.isImportant) filters.push("is:important");
        if (parsedAdvanced.isUnread) filters.push("is:unread");
        
        title = filters.length > 0 ? filters.join(' and ') : "Advanced search";
      } catch (e) {
        console.error("Failed to parse advanced search:", e);
      }
    } else if (query) {
      title = `"${query}"`;
    }
    
    return {
      searchQuery: query,
      advancedSearch: parsedAdvanced,
      searchTitle: title || "Search"
    };
  }, [query, advancedParam]);

  return (
    <div className="h-full">
      <div className="p-6" style={{ borderBottom: '1px solid var(--color-raycast-border-light)' }}>
        <h1 className="text-xl font-semibold" style={{ color: 'var(--color-raycast-text)' }}>
          Search results for {searchTitle}
        </h1>
        {advancedSearch && (
          <div className="mt-2 text-sm" style={{ color: 'var(--color-raycast-text-secondary)' }}>
            Advanced search with {Object.keys(advancedSearch).length - 1} filter(s)
          </div>
        )}
      </div>
      <ThreadList 
        search={searchQuery} 
        advancedSearch={advancedSearch || undefined}
        showMetrics={true}
      />
    </div>
  );
}