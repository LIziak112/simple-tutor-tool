import { SerialTaskQueue } from "@/lib/serial-task-queue";
/** 空闲预备与显式打开共用单一栅格队列。 */
export const questionBaseRenderQueue = new SerialTaskQueue();
