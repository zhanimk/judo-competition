import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  StreamableFile,
  Header,
  Post,
  Body,
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
import { ProtocolPublicationsService } from './protocol-publications.service.js';
import {
  ProtocolCreateDto,
  ProtocolVisibilityDto,
  ProtocolHistoryQuery,
} from './protocol-publication.dto.js';
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
  constructor(
    private readonly service: ProtocolsService,
    private readonly publications: ProtocolPublicationsService,
  ) {}
  @Get(':id/protocols')
  @Header('Cache-Control', 'private, no-store')
  history(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ProtocolHistoryQuery,
    @CurrentUser() user: Principal,
  ) {
    return this.publications.history(id, user, query.beforeVersion);
  }
  @Post(':id/protocols')
  createVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProtocolCreateDto,
    @CurrentUser() user: Principal,
  ) {
    return this.publications.create(id, dto, user);
  }
  @Post(':id/protocols/:artifactId/command')
  visibility(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('artifactId', ParseUUIDPipe) artifactId: string,
    @Body() dto: ProtocolVisibilityDto,
    @CurrentUser() user: Principal,
  ) {
    return this.publications.visibility(id, artifactId, dto, user);
  }
  @Get(':id/protocols/:artifactId.pdf')
  @Header('Cache-Control', 'private, no-store')
  async storedDownload(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('artifactId', ParseUUIDPipe) artifactId: string,
    @CurrentUser() user: Principal,
  ) {
    const artifact = await this.publications.download(id, artifactId, user);
    return new StreamableFile(artifact.bytes, {
      type: 'application/pdf',
      disposition: `attachment; filename="${artifact.filename}"`,
    });
  }
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
