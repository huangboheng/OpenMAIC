/** Shared avatar fallback constants for the Roundtable component family.
 *  使用 withBasePath 包裹以兼容 /openmaic 子路径部署。 */
import { withBasePath } from '@/lib/utils/base-path';

export const DEFAULT_TEACHER_AVATAR = withBasePath('/avatars/teacher.png');
export const DEFAULT_STUDENT_AVATAR = withBasePath('/avatars/user.png');
export const DEFAULT_USER_AVATAR = withBasePath('/avatars/user.png');
