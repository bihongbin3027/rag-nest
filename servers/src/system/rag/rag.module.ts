import { Module } from '@nestjs/common'

import { RagService } from './rag.service'
import { RagController } from './rag.controller'

// JwtAuthGuard 依赖 UserService（RagController 通过 @UseGuards(JwtAuthGuard) 触发实例化，
// Nest 会在 RagModule scope 里解析 guard 的依赖）。UserService 由 UserModule 提供且未标 @Global()，
// 所以这里必须显式 import UserModule，让 UserService 进入 RagModule 的可见域。
import { UserModule } from '../user/user.module'

@Module({
  imports: [UserModule],
  providers: [RagService],
  controllers: [RagController],
})
export class RagModule {}
