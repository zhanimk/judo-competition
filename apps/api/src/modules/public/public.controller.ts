import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Header,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { Public } from '../auth/auth.guard.js';
import { PublicService } from './public.service.js';
import { ProtocolPublicationsService } from '../protocols/protocol-publications.service.js';
import { ProtocolHistoryQuery } from '../protocols/protocol-publication.dto.js';
@Public()
@Controller('public/tournaments')
export class PublicController {
  constructor(
    private readonly service: PublicService,
    private readonly publications: ProtocolPublicationsService,
  ) {}
  @Get(':id/protocols')
  @Header('Cache-Control', 'no-store')
  protocols(@Param('id', ParseUUIDPipe) id: string, @Query() query: ProtocolHistoryQuery) {
    return this.publications.history(id, null, query.beforeVersion);
  }
  @Get(':id/protocols/:artifactId.pdf')
  @Header('Cache-Control', 'no-store')
  async protocol(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('artifactId', ParseUUIDPipe) artifactId: string,
  ) {
    const artifact = await this.publications.download(id, artifactId, null);
    return new StreamableFile(artifact.bytes, {
      type: 'application/pdf',
      disposition: `attachment; filename="${artifact.filename}"`,
    });
  }
  @Get() @Header('Cache-Control', 'no-store') list() {
    return this.service.list();
  }
  @Get(':id') @Header('Cache-Control', 'no-store') get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }
}
