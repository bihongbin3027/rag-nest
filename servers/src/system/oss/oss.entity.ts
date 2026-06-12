import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm'
import { Exclude } from 'class-transformer'
import { ApiProperty } from '@nestjs/swagger'

@Entity('sys_oss')
export class OssEntity {
  @ApiProperty({ description: 'id' })
  @PrimaryGeneratedColumn({ type: 'bigint' })
  public id: number

  @ApiProperty({ description: '上传用户id' })
  @Column({ type: 'bigint', name: 'user_id', comment: '上传用户id' })
  public userId: string

  @ApiProperty({ description: '上传用户帐号' })
  @Column({ type: 'varchar', name: 'user_account', length: 32, comment: '上传用户帐号' })
  public userAccount: string

  @ApiProperty({ description: '文件 url' })
  @Column({ type: 'varchar', comment: '文件 url' })
  public url: string

  @ApiProperty({ description: '文件size' })
  @Column({ type: 'int', comment: '文件size' })
  public size: number

  @ApiProperty({ description: '文件mimetype类型' })
  @Column({ type: 'varchar', comment: '文件mimetype类型' })
  public type: string

  @ApiProperty({ description: '原始文件名(RAG模块专属)' })
  @Column({ type: 'varchar', name: 'file_name', comment: '原始文件名(RAG模块专属)' })
  public file_name: number

  @ApiProperty({ description: '父级文件夹ID，0表示根目录' })
  @Column({ type: 'int', name: 'parent_id', comment: '父级文件夹ID，0表示根目录' })
  public parentId: number

  @ApiProperty({ description: '是否文件夹：0否，1是'  })
  @Column({ type: 'tinyint', name: 'is_dir', comment: '是否文文件夹：0否，1是' })
  public isDir: number

  @ApiProperty({ description: '向量化状态' })
  @Column({ type: 'varchar', name: 'vector_status', comment: '向量化状态' })
  public vectorStatus: string

  @ApiProperty({ description: 'RAG链路：VECTOR(文本向量), SQL(结构化表格)' })
  @Column({ type: 'varchar', name: 'rag_track', comment: 'RAG链路：VECTOR(文本向量), SQL(结构化表格)' })
  public ragTrack: string

  @ApiProperty({ description: 'Text-to-SQL 轨道专属：动态生成的物理表名' })
  @Column({ type: 'varchar', name: 'associated_table', comment: 'Text-to-SQL 轨道专属：动态生成的物理表名' })
  public associatedTable: string

  @ApiProperty({ description: '业务描述字段，可以字符串，也可以是 JSON 字符串' })
  @Column({ type: 'varchar', length: 200, comment: '业务描述字段，可以字符串，也可以是 JSON 字符串' })
  public business: string

  @Exclude({ toPlainOnly: true }) // 输出屏蔽
  @Column({ type: 'varchar', length: 200, comment: '文件存放位置' })
  public location: string

  @ApiProperty({ description: '上传时间' })
  @CreateDateColumn({ type: 'timestamp', name: 'create_date', comment: '创建时间' })
  createDate: Date | string
}
