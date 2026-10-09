import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  StreamableFile,
  Header,
} from '@nestjs/common';
import {
  IsIn,
  IsOptional,
  IsUUID,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ArrayUnique,
} from 'class-validator';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.types.js';
import { ProtocolsService } from './protocols.service.js';
import { Transform } from 'class-transformer';
import { PROTOCOL_KINDS, type ProtocolKind } from './protocol-model.js';
class ProtocolQuery {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',') : value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  categoryIds?: string[];
  @IsOptional() @IsIn(PROTOCOL_KINDS) kind: ProtocolKind = 'DRAW';
  @IsOptional() @IsIn(['ru', 'kk']) lang: 'ru' | 'kk' = 'ru';
}
@Controller('tournaments')
export class ProtocolsController {
  constructor(private readonly service: ProtocolsService) {}
  @Get(':id/protocol.pdf')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ProtocolQuery,
    @CurrentUser() user: Principal,
  ) {
    const buffer = await this.service.create(
      id,
      query.categoryId,
      query.lang,
      user,
      query.kind,
      query.categoryIds,
    );
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${query.kind.toLowerCase()}-${query.categoryId ?? id}-${query.lang}.pdf"`,
    });
  }
}
