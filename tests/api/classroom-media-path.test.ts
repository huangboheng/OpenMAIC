/**
 * classroom-media 路由路径包含性校验测试。
 *
 * 回归背景：Windows 下 process.cwd() 拼接的 base 与 fs.realpath 结果的
 * 大小写可能不一致（盘符 e:\ vs E:\），旧实现大小写敏感 startsWith 恒 false，
 * 导致全部音频/媒体文件被误判路径逃逸返回 404（课堂完全无声）。
 */
import { describe, expect, it } from 'vitest';
import { isPathWithinBase } from '@/app/api/classroom-media/[classroomId]/[...path]/route';

describe('isPathWithinBase', () => {
  describe('win32（大小写不敏感）', () => {
    it('盘符/路径大小写不一致仍判定为包含（根因回归）', () => {
      expect(
        isPathWithinBase(
          'e:\\hermes\\workspace\\openmaic\\data\\classrooms\\abc\\audio\\x.mp3',
          'E:\\hermes\\workspace\\openmaic\\data\\classrooms\\abc',
          'win32',
        ),
      ).toBe(true);
    });

    it('同大小写的正常包含', () => {
      expect(
        isPathWithinBase('C:\\data\\classrooms\\abc\\media\\img.png', 'C:\\data\\classrooms\\abc', 'win32'),
      ).toBe(true);
    });

    it('完全相等（base 自身）', () => {
      expect(isPathWithinBase('C:\\data\\classrooms\\abc', 'c:\\data\\classrooms\\abc', 'win32')).toBe(
        true,
      );
    });

    it('路径逃逸到 base 之外被拦截', () => {
      expect(
        isPathWithinBase('C:\\data\\classrooms\\other\\x.mp3', 'C:\\data\\classrooms\\abc', 'win32'),
      ).toBe(false);
      expect(isPathWithinBase('C:\\etc\\passwd', 'C:\\data\\classrooms\\abc', 'win32')).toBe(false);
    });

    it('前缀相似但非子目录（防 startsWith 前缀混淆）', () => {
      expect(
        isPathWithinBase('C:\\data\\classrooms\\abc-evil\\x.mp3', 'C:\\data\\classrooms\\abc', 'win32'),
      ).toBe(false);
    });
  });

  describe('posix（大小写敏感）', () => {
    it('正常包含', () => {
      expect(
        isPathWithinBase('/srv/data/classrooms/abc/audio/x.mp3', '/srv/data/classrooms/abc', 'linux'),
      ).toBe(true);
    });

    it('大小写不一致在 posix 上不放行（保持安全语义）', () => {
      expect(
        isPathWithinBase('/srv/data/Classrooms/abc/x.mp3', '/srv/data/classrooms/abc', 'linux'),
      ).toBe(false);
    });

    it('路径逃逸被拦截', () => {
      expect(
        isPathWithinBase('/srv/data/classrooms/other/x.mp3', '/srv/data/classrooms/abc', 'linux'),
      ).toBe(false);
    });
  });
});
