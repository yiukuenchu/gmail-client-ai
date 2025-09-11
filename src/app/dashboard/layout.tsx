import { redirect } from "next/navigation";
import { auth } from "~/server/auth";
import { Sidebar } from "./_components/sidebar";
import { Header } from "./_components/header";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session) {
    redirect("/");
  }

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-x-auto overflow-y-auto bg-white">
          {children}
        </main>
      </div>
    </div>
  );
}