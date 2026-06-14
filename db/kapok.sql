/*
 Navicat Premium Data Transfer

 Source Server         : 本地
 Source Server Type    : MySQL
 Source Server Version : 80027
 Source Host           : localhost:3306
 Source Schema         : kapok

 Target Server Type    : MySQL
 Target Server Version : 80027
 File Encoding         : 65001
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for sys_dept
-- ----------------------------
DROP TABLE IF EXISTS `sys_dept`;
CREATE TABLE `sys_dept`  (
  `id` bigint(0) NOT NULL AUTO_INCREMENT,
  `parent_id` bigint(0) NOT NULL COMMENT '父级部门 id',
  `status` tinyint(0) NOT NULL DEFAULT 1 COMMENT '部门状态，1-有效，0-禁用',
  `order_num` int(0) NOT NULL DEFAULT 0 COMMENT '排序',
  `create_date` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  `remark` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '备注',
  `name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '部门名称',
  `leader` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '部门负责人',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 4 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of sys_dept
-- ----------------------------
INSERT INTO `sys_dept` VALUES (1, 0, 1, 0, '2026-06-04 00:16:02.040115', '总公司', 'K科技有限公司', 'kapok');
INSERT INTO `sys_dept` VALUES (2, 1, 1, 0, '2026-06-04 00:16:46.557000', '杭州分部', '杭州技术部', 'kapok');

-- ----------------------------
-- Table structure for sys_menu
-- ----------------------------
DROP TABLE IF EXISTS `sys_menu`;
CREATE TABLE `sys_menu`  (
  `id` bigint(0) NOT NULL AUTO_INCREMENT,
  `name` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '菜单名称',
  `code` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '菜单/按钮唯一标识，由前端路由name,用于控制菜单按钮显隐',
  `type` int(0) NOT NULL COMMENT '菜单类型， 1-菜单/目录 2-tabs 3-按钮',
  `order_num` int(0) NOT NULL DEFAULT 0 COMMENT '排序',
  `parent_id` bigint(0) NOT NULL,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 33 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of sys_menu
-- ----------------------------
INSERT INTO `sys_menu` VALUES (1, '首页', 'dashboard', 1, 0, 0);
INSERT INTO `sys_menu` VALUES (2, 'RAG管理', 'rag-dir', 1, 0, 0);
INSERT INTO `sys_menu` VALUES (3, '知识库资源管理', 'rag', 1, 0, 2);
INSERT INTO `sys_menu` VALUES (4, '权限管理', 'perm', 1, 0, 0);
INSERT INTO `sys_menu` VALUES (5, '用户管理', 'perm_users', 1, 0, 4);
INSERT INTO `sys_menu` VALUES (6, '角色管理', 'perm_roles', 1, 0, 4);
INSERT INTO `sys_menu` VALUES (7, '部门管理', 'perm_depts', 1, 0, 4);
INSERT INTO `sys_menu` VALUES (8, '岗位管理', 'perm_posts', 1, 0, 4);
INSERT INTO `sys_menu` VALUES (9, '系统设置', 'system', 1, 0, 0);
INSERT INTO `sys_menu` VALUES (10, '资源管理', 'system_menus', 1, 0, 9);
INSERT INTO `sys_menu` VALUES (11, '文件列表', 'system_oss', 1, 0, 9);
INSERT INTO `sys_menu` VALUES (12, '编辑', 'perm_users:edit', 3, 0, 5);
INSERT INTO `sys_menu` VALUES (13, '启用/禁用', 'perm_users:updateStatus', 3, 0, 5);
INSERT INTO `sys_menu` VALUES (14, '重置密码', 'perm_users:resetPw', 3, 0, 5);
INSERT INTO `sys_menu` VALUES (15, '批量导入', 'perm_users:createMultUser', 3, 0, 5);
INSERT INTO `sys_menu` VALUES (16, '新增', 'perm_roles:create', 3, 0, 6);
INSERT INTO `sys_menu` VALUES (17, '编辑', 'perm_roles:edit', 3, 0, 6);
INSERT INTO `sys_menu` VALUES (18, '删除', 'perm_roles:del', 3, 0, 6);
INSERT INTO `sys_menu` VALUES (19, '关联用户/解除关联', 'perm_roles:bind', 3, 0, 6);
INSERT INTO `sys_menu` VALUES (20, '添加', 'system_menus:create', 3, 0, 10);
INSERT INTO `sys_menu` VALUES (21, '编辑', 'system_menus:edit', 3, 0, 10);
INSERT INTO `sys_menu` VALUES (22, '删除', 'system_menus:del', 3, 0, 10);
INSERT INTO `sys_menu` VALUES (23, '新增', 'perm_posts:create', 3, 0, 8);
INSERT INTO `sys_menu` VALUES (24, '编辑', 'perm_posts:edit', 3, 0, 8);
INSERT INTO `sys_menu` VALUES (25, '删除', 'perm_posts:del', 3, 0, 8);
INSERT INTO `sys_menu` VALUES (26, '删除', 'perm_depts:del', 3, 0, 7);
INSERT INTO `sys_menu` VALUES (27, '编辑', 'perm_depts:edit', 3, 0, 7);
INSERT INTO `sys_menu` VALUES (28, '新增', 'perm_depts:create', 3, 0, 7);

-- ----------------------------
-- Table structure for sys_menu_perm
-- ----------------------------
DROP TABLE IF EXISTS `sys_menu_perm`;
CREATE TABLE `sys_menu_perm`  (
  `id` bigint(0) NOT NULL AUTO_INCREMENT,
  `menu_id` bigint(0) NOT NULL COMMENT '菜单id',
  `api_url` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '该菜单所能调用的 api 接口，必须是本应用的接口，否则设置了也不生效',
  `api_method` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '该菜单所能调用 api 接口的 method 方法',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 41 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of sys_menu_perm
-- ----------------------------
INSERT IGNORE INTO `sys_menu_perm` (`id`, `menu_id`, `api_url`, `api_method`) VALUES
  -- 知识库资源管理 (id=3)
  (42, 3, '/api/rag/files/list',     'GET'),
  (43, 3, '/api/rag/folder/create',   'POST'),
  (44, 3, '/api/rag/file/register',   'POST'),
  -- 用户管理 (id=5)
  (45, 5, '/api/user/list',                       'GET'),
  (46, 5, '/api/user/one/info',                   'GET'),
  (47, 5, '/api/user/:id/role',                   'GET'),
  (48, 5, '/api/user',                            'PUT'),
  (49, 5, '/api/user/import',                     'POST'),
  -- 角色管理 (id=6)
  (50, 6, '/api/role/list',                       'GET'),
  (51, 6, '/api/role/one/:id/perms',              'GET'),
  (52, 6, '/api/role',                            'POST'),
  (53, 6, '/api/role',                            'PUT'),
  (54, 6, '/api/role/:id',                        'DELETE'),
  (55, 6, '/api/user/role/update',                'POST'),
  -- 部门管理 (id=7)
  (56, 7, '/api/dept/list',                       'GET'),
  (57, 7, '/api/dept',                            'POST'),
  (58, 7, '/api/dept',                            'PUT'),
  (59, 7, '/api/dept/:id',                        'DELETE'),
  -- 岗位管理 (id=8)
  (60, 8, '/api/post/list',                       'GET'),
  (61, 8, '/api/post/:id',                        'GET'),
  (62, 8, '/api/post',                            'POST'),
  (63, 8, '/api/post',                            'PUT'),
  (64, 8, '/api/post/:id',                        'DELETE'),
  -- 资源管理 (id=10)
  (65, 10, '/api/menu/all',                       'GET'),
  (66, 10, '/api/menu/one/:parentId/btns',       'GET'),
  (67, 10, '/api/menu/one/:id/menu-perm',         'GET'),
  (68, 10, '/api/menu',                           'POST'),
  (69, 10, '/api/menu',                           'PUT'),
  (70, 10, '/api/menu/:id',                       'DELETE'),
  -- 文件列表 (id=11)
  (71, 11, '/api/oss/list',                       'GET'),
  (72, 11, '/api/oss/upload',                     'POST');

-- ----------------------------
-- Table structure for sys_oss
-- ----------------------------
DROP TABLE IF EXISTS `sys_oss`;
CREATE TABLE `sys_oss`  (
  `id` bigint(0) NOT NULL AUTO_INCREMENT,
  `url` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '文件 url',
  `file_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '原始文件名(RAG模块专属)',
  `size` int(0) NOT NULL COMMENT '文件size',
  `location` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '文件存放位置',
  `create_date` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  `business` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '业务描述字段，可以字符串，也可以是 JSON 字符串',
  `user_id` bigint(0) NOT NULL COMMENT '上传用户id',
  `user_account` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '上传用户帐号',
  `type` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '文件mimetype类型',
  `parent_id` int(11) NULL DEFAULT 0 COMMENT '父级文件夹ID，0表示根目录',
  `is_dir` tinyint(1) NULL DEFAULT 0 COMMENT '是否为文件夹：0否，1是',
  `vector_status` varchar(20) NULL DEFAULT 'unprocessed' COMMENT '向量化状态：unprocessed未处理, processing处理中, success成功, failed失败',
  `associated_table` varchar(255) NULL DEFAULT NULL COMMENT 'Text-to-SQL 轨道专属：动态生成的物理表名',
  `rag_track` varchar(255) NULL DEFAULT NULL COMMENT 'RAG链路：VECTOR(文本向量), SQL(结构化表格)',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 6 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for sys_post
-- ----------------------------
DROP TABLE IF EXISTS `sys_post`;
CREATE TABLE `sys_post`  (
  `id` bigint(0) NOT NULL AUTO_INCREMENT,
  `code` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '岗位编码',
  `status` tinyint(0) NOT NULL DEFAULT 1 COMMENT '岗位状态，1-有效，0-禁用',
  `remark` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT '备注',
  `order_num` int(0) NOT NULL DEFAULT 0 COMMENT '排序',
  `create_date` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  `name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '岗位名称',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 5 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of sys_post
-- ----------------------------
INSERT INTO `sys_post` VALUES (2, 'hr', 0, '山东科技山东科技花生壳', 1, '2026-06-06 20:32:01.513000', '人事');
INSERT INTO `sys_post` VALUES (3, 'it', 1, '写代码', 0, '2026-06-06 20:32:56.250000', '技术员');

-- ----------------------------
-- Table structure for sys_role
-- ----------------------------
DROP TABLE IF EXISTS `sys_role`;
CREATE TABLE `sys_role`  (
  `id` bigint(0) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '角色名称',
  `remark` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '角色备注',
  `create_date` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  `update_date` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 3 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of sys_role
-- ----------------------------
INSERT INTO `sys_role` VALUES (1, '普通用户', '普通用户', '2026-06-01 21:41:50.187783', '2026-06-02 21:41:50.187783');

-- ----------------------------
-- Table structure for sys_role_menu
-- ----------------------------
DROP TABLE IF EXISTS `sys_role_menu`;
CREATE TABLE `sys_role_menu`  (
  `id` bigint(0) NOT NULL AUTO_INCREMENT,
  `role_id` bigint(0) NOT NULL COMMENT '角色 id',
  `menu_id` bigint(0) NOT NULL COMMENT '菜单 id',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 24 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of sys_role_menu
-- ----------------------------
-- role_id=1 超管：拥有全部菜单（含 type=3 按钮权限，便于 sys_menu_perm 链路完整）
INSERT INTO `sys_role_menu` VALUES (1, 1, 1);
-- role_id=2 普通用户（test）：补全为"所有 type=1 菜单都可见"
-- 注：这是测试账号，请按业务最小权限原则再收敛
INSERT IGNORE INTO `sys_role_menu` (`id`, `role_id`, `menu_id`) VALUES
  (21, 2, 1),     -- 首页
  (22, 2, 2),     -- RAG管理（父级）
  (23, 2, 3),     -- 知识库资源管理
  (24, 2, 4),     -- 权限管理（父级）
  (25, 2, 5),     -- 用户管理
  (26, 2, 6),     -- 角色管理
  (27, 2, 7),     -- 部门管理
  (28, 2, 8),     -- 岗位管理
  (29, 2, 9),     -- 系统设置（父级）
  (30, 2, 10),    -- 资源管理
  (31, 2, 11);    -- 文件列表

-- ----------------------------
-- Table structure for sys_user
-- ----------------------------
DROP TABLE IF EXISTS `sys_user`;
CREATE TABLE `sys_user`  (
  `id` bigint(0) NOT NULL AUTO_INCREMENT,
  `password` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '用户登录密码',
  `salt` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '盐',
  `account` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '用户登录账号',
  `phone_num` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '用户手机号码',
  `email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '邮箱地址',
  `status` tinyint(0) NOT NULL DEFAULT 1 COMMENT '所属状态: 1-有效，0-禁用',
  `avatar` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '头像地址',
  `type` tinyint(0) NOT NULL DEFAULT 1 COMMENT '帐号类型：0-超管， 1-普通用户',
  `create_date` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  `update_date` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 3 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of sys_user
-- ----------------------------
INSERT INTO `sys_user` VALUES (1, '$2a$10$JChCYKwJYbVV4ANalu2tBenViaF3fuQGAJ1NSBOtR8HJNCV7H710i', '$2a$10$JChCYKwJYbVV4ANalu2tBe', 'admin', '18374914562', '123@qq.com', 1, 'http://localhost:8081/static/67f57d2058984103afc54d164aff5648.jpeg', 0, '2026-06-01 16:09:23.000000', '2026-06-01 16:09:23.000000');
INSERT INTO `sys_user` VALUES (2, '$2a$10$NSrq5H2chKrcMy/AeiHqK.C1ER40JmLWCh/OIpXkL/nZ4lHN/epse', '$2a$10$NSrq5H2chKrcMy/AeiHqK.', 'test', '18374915874', '12345@qq.com', 1, 'http://localhost:8081/static/67f57d2058984103afc54d164aff5648.jpeg', 1, '2026-06-01 15:25:47.000000', '2026-06-01 15:25:47.000000');

-- ----------------------------
-- Table structure for sys_user_dept
-- ----------------------------
DROP TABLE IF EXISTS `sys_user_dept`;
CREATE TABLE `sys_user_dept`  (
  `id` bigint(0) NOT NULL AUTO_INCREMENT,
  `user_id` bigint(0) NOT NULL COMMENT '用户id',
  `dept_id` bigint(0) NOT NULL COMMENT '部门id',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 1 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of sys_user_dept
-- ----------------------------
INSERT INTO `sys_user_dept` VALUES (1, 2, 2);

-- ----------------------------
-- Table structure for sys_user_post
-- ----------------------------
DROP TABLE IF EXISTS `sys_user_post`;
CREATE TABLE `sys_user_post`  (
  `id` bigint(0) NOT NULL AUTO_INCREMENT,
  `user_id` bigint(0) NOT NULL COMMENT '用户id',
  `post_id` bigint(0) NOT NULL COMMENT '岗位id',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of sys_user_post
-- ----------------------------

-- ----------------------------
-- Table structure for sys_user_role
-- ----------------------------
DROP TABLE IF EXISTS `sys_user_role`;
CREATE TABLE `sys_user_role`  (
  `id` bigint(0) NOT NULL AUTO_INCREMENT,
  `user_id` bigint(0) NOT NULL COMMENT '用户id',
  `role_id` bigint(0) NOT NULL COMMENT '角色id',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 34 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Records of sys_user_role
-- ----------------------------
INSERT INTO `sys_user_role` VALUES (33, 2, 2);
INSERT INTO `sys_user_role` VALUES (34, 2, 1);

SET FOREIGN_KEY_CHECKS = 1;
