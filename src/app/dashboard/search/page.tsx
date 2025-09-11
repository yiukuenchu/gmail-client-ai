"use client";

import { useSearchParams } from "next/navigation";
import { api } from "~/trpc/react";
import { ThreadList } from "../_components/thread-list";

export default function SearchPage() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") || "";

  return (
    <div className="h-full">
      <div className="p-6 border-b">
        <h1 className="text-xl font-semibold text-gray-900">
          Search results for "{query}"
        </h1>
      </div>
      <ThreadList search={query} />
    </div>
  );
}