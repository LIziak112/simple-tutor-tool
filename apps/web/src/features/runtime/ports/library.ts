import type {
  CourseProgressData,
  LectureMetaData,
  LectureMetaUpdate,
  LibraryBatchData,
  LibraryBatchRequest,
  LibraryFolder,
  LibraryFolderCreate,
  LibraryFolderReorder,
  LibraryFolderUpdate,
  LibraryLectureList,
  LibraryUnitList,
  LibraryUsage,
  UnitMetaData,
  UnitMetaUpdate,
} from "@tutor/contract";
import type { LibraryListParams } from "@/features/runtime/client-types";
export interface LibraryPorts {
  fetchCourseProgressApi(courseId: string): Promise<CourseProgressData>;
  fetchLibraryFolders(): Promise<{
    folders: LibraryFolder[];
  }>;
  createLibraryFolderApi(request: LibraryFolderCreate): Promise<LibraryFolder>;
  renameLibraryFolderApi(
    id: string,
    request: LibraryFolderUpdate,
  ): Promise<LibraryFolder>;
  deleteLibraryFolderApi(id: string): Promise<{
    movedLectures: number;
    movedUnits: number;
  }>;
  reorderLibraryFoldersApi(request: LibraryFolderReorder): Promise<null>;
  fetchLibraryLectures(params?: LibraryListParams): Promise<LibraryLectureList>;
  fetchLibraryUnits(params?: LibraryListParams): Promise<LibraryUnitList>;
  updateUnitMetaApi(id: string, request: UnitMetaUpdate): Promise<UnitMetaData>;
  deleteUnitApi(id: string): Promise<null>;
  restoreUnitApi(id: string): Promise<null>;
  purgeUnitApi(id: string): Promise<null>;
  updateLectureFolderApi(
    id: string,
    request: LectureMetaUpdate,
  ): Promise<LectureMetaData>;
  restoreLectureApi(id: string): Promise<null>;
  purgeLectureApi(id: string): Promise<null>;
  fetchUnitUsageApi(id: string): Promise<LibraryUsage>;
  fetchLectureUsageApi(id: string): Promise<LibraryUsage>;
  batchLibraryApi(request: LibraryBatchRequest): Promise<LibraryBatchData>;
  downloadExportMd(kind: "unit" | "lecture", id: string): Promise<void>;
  downloadTeachingPack(kind: "unit" | "lecture", id: string): Promise<void>;
}
