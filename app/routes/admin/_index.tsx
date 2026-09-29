import { redirect } from "react-router";
import { requireAdmin } from "../../lib/auth";

export async function clientLoader() {
  await requireAdmin();
  return redirect("/admin/map");
}

export default function AdminIndex() {
  return null;
}
