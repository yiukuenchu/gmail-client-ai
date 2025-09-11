"use client";

import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import { ThreadList } from "../../_components/thread-list";

export default function LabelPage() {
  const params = useParams();
  const labelId = params.labelId as string;

  const { data: labels } = api.gmail.getLabels.useQuery();
  const label = labels?.find(l => l.id === labelId);

  return (
    <div className="h-full">
      <div className="p-6 border-b">
        <h1 className="text-xl font-semibold text-gray-900">
          {label ? label.name : "Label"}
        </h1>
      </div>
      <ThreadList labelId={labelId} />
    </div>
  );
}