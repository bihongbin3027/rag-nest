import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm'
import { ServeStaticModule, ServeStaticModuleOptions } from '@nestjs/serve-static'
import { APP_GUARD } from '@nestjs/core'
import { PrometheusModule } from '@willsoto/nestjs-prometheus'
import path from 'path'

import configuration from './config/index'
import { RedisOptions } from 'ioredis'

import { RedisModule } from './common/libs/redis/redis.module'
import { JwtAuthGuard } from './common/guards/auth.guard'
import { RolesGuard } from './common/guards/roles.guard'
import { HealthModule } from './common/health/health.module'
import { MetricsModule } from './common/metrics/metrics.module'
import { BullModule } from '@nestjs/bullmq'

import { UserModule } from './system/user/user.module'
import { AuthModule } from './system/auth/auth.module'
import { MenuModule } from './system/menu/menu.module'
import { RoleModule } from './system/role/role.module'
import { PermModule } from './system/perm/perm.module'
import { OssModule } from './system/oss/oss.module'
import { DeptModule } from './system/dept/dept.module'
import { PostModule } from './system/post/post.module'
import { RagModule } from './system/rag/rag.module'

@Module({
  imports: [
    // 配置模块
    ConfigModule.forRoot({
      cache: true,
      load: [configuration],
      isGlobal: true,
    }),
    // 服务静态化, 生产环境最好使用 nginx 做资源映射， 可以根据环境配置做区分
    ServeStaticModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const fileUploadLocationConfig = config.get<string>('app.file.location') || '../upload'
        const rootPath = path.isAbsolute(fileUploadLocationConfig)
          ? `${fileUploadLocationConfig}`
          : path.join(process.cwd(), `${fileUploadLocationConfig}`)
        return [
          {
            rootPath,
            exclude: [`${config.get('app.prefix')}`],
            serveRoot: config.get('app.file.serveRoot'),
            serveStaticOptions: {
              cacheControl: true,
            },
          },
        ] as ServeStaticModuleOptions[]
      },
    }),
    // 数据库
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return {
          type: 'mysql',
          // 可能不再支持这种方式，entities 将改成接收 实体类的引用
          //
          // entities: [`${__dirname}/**/*.entity{.ts,.js}`],
          autoLoadEntities: true,
          ...config.get('db.mysql'),
          // cache: {
          //   type: 'ioredis',
          //   ...config.get('redis'),
          //   alwaysEnabled: true,
          //   duration: 3 * 1000, // 缓存3s
          // },
        } as TypeOrmModuleOptions
      },
    }),
    // libs redis(自封装 ioredis,弃用 @liaoliaots/nestjs-redis)
    RedisModule.forRootAsync(
      {
        useFactory: (config: ConfigService) => config.get<RedisOptions>('redis'),
      },
      true,
    ),
    // 【P1-1】Prometheus 指标抓取端点 /metrics（默认启用 HTTP 请求时长等基础指标）
    // path 必须配在 JwtAuthGuard 之外，否则需要 token 才能抓指标
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: { enabled: true },
    }),
    // 【P1-1】健康检查端点 /health / health/live / health/ready
    HealthModule,
    // 【P1-1】RAG 业务指标（RagMetricsService 全局可见）
    MetricsModule,
    // 【P1-2】BullMQ 全局队列：ETL 任务持久化 + 重试策略 + 并发控制（替代 SimpleSemaphore）
    // 【P1-2 修复】必须显式剔除 keyPrefix —— BullMQ 用自己的 key 命名（bull:<queue>:<id>），
    //   如果把 dev.yml 里的 `keyPrefix: "nest:"` 透传进去，ioredis 会把 BullMQ 写的 key 改成 `nest:bull:...`，
    //   Worker 完成时 `moveToFinished` Lua 脚本找不到原 job key → "Missing key for job" 报错。
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisCfg = config.get<any>('redis') || {}
        const { keyPrefix: _omit, ...bullConn } = redisCfg
        return { connection: bullConn }
      },
    }),
    // 系统基础模块
    UserModule,
    AuthModule,
    MenuModule,
    RoleModule,
    PermModule,
    DeptModule,
    PostModule,
    OssModule,
    RagModule,
    // 业务功能模块
  ],
  // app module 守卫，两个守卫分别依赖 UserService、PermService, 而 UserService、PermService 没有设置全局模块，
  // 所以这俩 守卫 不能再 main.ts 设置全局守卫
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
