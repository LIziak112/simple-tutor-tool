/**
 * Touch.touchType 类型补充：Safari（iPadOS）与 Chrome 提供，用于区分
 * Apple Pencil（'stylus'）与手指（'direct'）；TS DOM lib 尚未收录，此处补充
 * 为可选属性（桌面 Firefox 等不支持时为 undefined，代码按无笔处理）。
 */
interface Touch {
  touchType?: string;
}
