import { Controller, Get, Post, Param, Body, ParseUUIDPipe, Header, Req } from '@nestjs/common';
import { CurrentUser, Public } from '../auth/auth.guard.js';
import type { AuthRequest, Principal } from '../auth/auth.types.js';
import { MatchesService } from './matches.service.js';
import { MatchCommandDto } from './matches.dto.js';
@Controller('tatamis/:tatamiId/live')
export class MatchesController {
  constructor(private readonly service: MatchesService) {}
  @Public() @Get() @Header('Cache-Control', 'no-store') get(
    @Param('tatamiId', ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.publicView(id, req.headers.cookie);
  }
  @Post(':id/command') command(
    @Param('tatamiId', ParseUUIDPipe) mat: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MatchCommandDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.command(mat, id, dto, user);
  }
}
