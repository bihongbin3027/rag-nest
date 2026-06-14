import { Column, Entity, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm'
import { ApiProperty } from '@nestjs/swagger'

export enum RagTrackEnum {
  SQL = 'sql',
  VECTOR = 'vector',
}

export enum VectorStatusEnum {
  PENDING = 'pending', // 未开始 / 待入队
  PROCESSING = 'processing', // 向量化切片中
  SUCCESS = 'success', // 向量化成功
  FAILED = 'failed', // 向量化失败
}

@Entity({ name: 'sys_rag_file' })
export class RagFileEntity {
  @PrimaryGeneratedColumn({ comment: '主键ID' })
  id: number

  @Column({ type: 'varchar', length: 255, comment: '文件/文件夹名称' })
  fileName: string

  @Column({ type: 'int', default: 0, comment: '父级ID，0代表根目录' })
  parentId: number

  @Column({ type: 'tinyint', default: 0, comment: '是否为文件夹：0否，1是' })
  isFolder: number

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '存储在OSS的Key或路径' })
  fileUrl: string

  @Column({ type: 'bigint', default: 0, comment: '文件大小(Byte)' })
  size: number

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '文件后缀名' })
  fileType: string

  @Column({ type: 'enum', enum: RagTrackEnum, default: RagTrackEnum.VECTOR, comment: 'RAG算力轨制' })
  ragTrack: RagTrackEnum

  @Column({ type: 'enum', enum: VectorStatusEnum, default: VectorStatusEnum.PENDING, comment: '高维向量化状态' })
  vectorStatus: VectorStatusEnum

  @Column({ type: 'text', nullable: true, comment: '向量化失败原因归档' })
  errorMessage: string

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn({ type: 'timestamp', name: 'create_at', comment: '创建时间' })
  createdAt: Date

  @ApiProperty({ description: '更新时间' })
  @CreateDateColumn({ type: 'timestamp', name: 'update_at', comment: '更新时间' })
  updatedAt: Date
}
