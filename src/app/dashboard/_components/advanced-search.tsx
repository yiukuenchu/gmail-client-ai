"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { 
  SearchIcon, 
  XIcon, 
  CalendarIcon, 
  PaperclipIcon, 
  StarIcon, 
  AlertCircleIcon,
  MailIcon,
  UserIcon,
  FilterIcon,
  HelpCircleIcon
} from "lucide-react";
import { cn } from "~/lib/utils";

interface AdvancedSearchProps {
  isOpen: boolean;
  onClose: () => void;
  initialQuery?: string;
}

export function AdvancedSearch({ isOpen, onClose, initialQuery = "" }: AdvancedSearchProps) {
  const router = useRouter();
  
  // Text search fields
  const [subject, setSubject] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [content, setContent] = useState(initialQuery);
  const [attachmentName, setAttachmentName] = useState("");
  
  // Date filters
  const [dateRange, setDateRange] = useState<string>("");
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");
  
  // Status filters
  const [hasAttachments, setHasAttachments] = useState<boolean | undefined>(undefined);
  const [isStarred, setIsStarred] = useState<boolean | undefined>(undefined);
  const [isImportant, setIsImportant] = useState<boolean | undefined>(undefined);
  const [isUnread, setIsUnread] = useState<boolean | undefined>(undefined);
  
  

  const handleSearch = () => {
    const params = new URLSearchParams();
    
    // Build advanced search object
    const advancedSearch: any = {};
    
    if (subject) advancedSearch.subject = subject;
    if (from) advancedSearch.from = from;
    if (to) advancedSearch.to = to;
    if (content) advancedSearch.content = content;
    if (attachmentName) advancedSearch.attachmentName = attachmentName;
    
    if (dateRange) advancedSearch.dateRange = dateRange;
    if (dateAfter) advancedSearch.dateAfter = dateAfter;
    if (dateBefore) advancedSearch.dateBefore = dateBefore;
    
    if (hasAttachments !== undefined) advancedSearch.hasAttachments = hasAttachments;
    if (isStarred !== undefined) advancedSearch.isStarred = isStarred;
    if (isImportant !== undefined) advancedSearch.isImportant = isImportant;
    if (isUnread !== undefined) advancedSearch.isUnread = isUnread;
    
    // Only add advanced search params if there are any filters
    if (Object.keys(advancedSearch).length > 0) {
      params.set("advanced", JSON.stringify(advancedSearch));
      router.push(`/dashboard/search?${params.toString()}`);
    } else {
      // If no filters, just go to simple search page without advanced params
      router.push(`/dashboard/search`);
    }
    onClose();
  };

  const handleReset = () => {
    setSubject("");
    setFrom("");
    setTo("");
    setContent("");
    setAttachmentName("");
    setDateRange("");
    setDateAfter("");
    setDateBefore("");
    setHasAttachments(undefined);
    setIsStarred(undefined);
    setIsImportant(undefined);
    setIsUnread(undefined);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}>
      <div className="raycast-card w-full max-w-3xl max-h-[90vh] overflow-y-auto" style={{ backgroundColor: 'var(--color-raycast-surface)' }}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold flex items-center gap-2" style={{ color: 'var(--color-raycast-text)' }}>
              <FilterIcon className="w-5 h-5" />
              Advanced Search
            </h2>
            <button onClick={onClose} className="raycast-button p-2">
              <XIcon className="w-5 h-5" />
            </button>
          </div>

          <div className="space-y-6">
            {/* Text Search Section */}
            <div>
              <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--color-raycast-text-secondary)' }}>
                Text Search
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--color-raycast-text-tertiary)' }}>Subject</label>
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="e.g., meeting notes"
                    className="raycast-input w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--color-raycast-text-tertiary)' }}>From</label>
                  <input
                    type="text"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    placeholder="e.g., john@example.com"
                    className="raycast-input w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--color-raycast-text-tertiary)' }}>To/CC/BCC</label>
                  <input
                    type="text"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder="e.g., team@company.com"
                    className="raycast-input w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--color-raycast-text-tertiary)' }}>Content</label>
                  <input
                    type="text"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Search in message body"
                    className="raycast-input w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--color-raycast-text-tertiary)' }}>Attachment Name</label>
                  <input
                    type="text"
                    value={attachmentName}
                    onChange={(e) => setAttachmentName(e.target.value)}
                    placeholder="e.g., report.pdf"
                    className="raycast-input w-full"
                  />
                </div>
              </div>
            </div>

            {/* Date Filters Section */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-sm font-medium" style={{ color: 'var(--color-raycast-text-secondary)' }}>
                  Date Filters
                </h3>
                <div className="relative group">
                  <HelpCircleIcon className="w-4 h-4" style={{ color: 'var(--color-raycast-text-tertiary)' }} />
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-md whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10">
                    Select 'Any time' to use custom date ranges, or choose a quick range preset
                    <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--color-raycast-text-tertiary)' }}>Quick Range</label>
                  <select
                    value={dateRange}
                    onChange={(e) => setDateRange(e.target.value)}
                    className="raycast-input w-full"
                  >
                    <option value="">Any time</option>
                    <option value="today">Today</option>
                    <option value="yesterday">Yesterday</option>
                    <option value="lastWeek">Last 7 days</option>
                    <option value="lastMonth">Last 30 days</option>
                    <option value="lastYear">Last year</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--color-raycast-text-tertiary)' }}>After Date</label>
                  <input
                    type="date"
                    value={dateAfter}
                    onChange={(e) => setDateAfter(e.target.value)}
                    className="raycast-input w-full"
                    disabled={!!dateRange}
                  />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--color-raycast-text-tertiary)' }}>Before Date</label>
                  <input
                    type="date"
                    value={dateBefore}
                    onChange={(e) => setDateBefore(e.target.value)}
                    className="raycast-input w-full"
                    disabled={!!dateRange}
                  />
                </div>
              </div>
            </div>

            {/* Status Filters Section */}
            <div>
              <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--color-raycast-text-secondary)' }}>
                Status Filters
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hasAttachments === true}
                    onChange={(e) => setHasAttachments(e.target.checked ? true : undefined)}
                    className="raycast-checkbox"
                  />
                  <PaperclipIcon className="w-4 h-4" />
                  <span className="text-sm">Has attachments</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isStarred === true}
                    onChange={(e) => setIsStarred(e.target.checked ? true : undefined)}
                    className="raycast-checkbox"
                  />
                  <StarIcon className="w-4 h-4" />
                  <span className="text-sm">Starred</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isImportant === true}
                    onChange={(e) => setIsImportant(e.target.checked ? true : undefined)}
                    className="raycast-checkbox"
                  />
                  <AlertCircleIcon className="w-4 h-4" />
                  <span className="text-sm">Important</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isUnread === true}
                    onChange={(e) => setIsUnread(e.target.checked ? true : undefined)}
                    className="raycast-checkbox"
                  />
                  <MailIcon className="w-4 h-4" />
                  <span className="text-sm">Unread</span>
                </label>
              </div>
            </div>

          </div>

          <div className="flex items-center justify-end gap-3 mt-6 pt-6" style={{ borderTop: '1px solid var(--color-raycast-border-light)' }}>
            <button onClick={handleReset} className="raycast-button">
              Reset
            </button>
            <button onClick={handleSearch} className="raycast-button primary flex items-center gap-2">
              <SearchIcon className="w-4 h-4" />
              Search
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}