import { redirect } from "react-router";
import { requireAdmin } from "../../lib/auth";

export async function clientLoader() {
  await requireAdmin();
  return redirect("/admin/compose");
}

export default function AdminIndex() {
  return null;
}
