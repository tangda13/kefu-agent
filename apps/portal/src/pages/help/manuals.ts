import { adminManual } from "./content/admin";
import { studentManual } from "./content/student";
import { teacherManual } from "./content/teacher";
import type { HelpManual, ManualId } from "./model";

export const MANUALS: Record<ManualId, HelpManual> = {
  student: studentManual,
  teacher: teacherManual,
  admin: adminManual,
};
