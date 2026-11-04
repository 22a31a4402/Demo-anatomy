/**
 * Helper to extract student name from answer script file name in the format:
 * Student Name_Sub name & Test on. _Date of exam
 */
export const extractStudentNameFromFile = (fileName: string): string => {
  if (!fileName) return 'Student Name';
  
  // Extract base filename (excluding extension or potential path segments)
  const baseNameWithExt = fileName.split('/').pop() || fileName;
  const baseName = baseNameWithExt.replace(/\.[^/.]+$/, "").trim();
  
  // According to format: Student Name_Sub name & Test on. _Date of exam
  // splitting by underscore gives the Student Name as the first token.
  if (baseName.includes('_')) {
    const parts = baseName.split('_');
    const studentPart = parts[0].trim();
    if (studentPart) {
      return studentPart;
    }
  }
  
  // Fallback if no underscores are present in the filename
  return baseName
    .replace(/[-_]/g, " ")
    .replace(/(answers|script|test|exam|sheet|paper)/gi, "")
    .replace(/\s+/g, " ")
    .trim() || 'Student Name';
};
