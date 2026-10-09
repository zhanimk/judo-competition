import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.types.js';
import { ControlService } from './control.service.js';
import { ControlCommandDto } from './control.dto.js';
@Controller('tournaments/:tournamentId/control')
export class ControlController {
  constructor(private readonly service: ControlService) {}
  @Get() @Header('Cache-Control', 'no-store') get(
    @Param('tournamentId', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.dashboard(id, user);
  }
  @Get(':contestId/impact') @Header('Cache-Control', 'no-store') impact(
    @Param('tournamentId', ParseUUIDPipe) id: string,
    @Param('contestId', ParseUUIDPipe) contest: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.impact(id, contest, user);
  }
  @Post(':contestId/command') command(
    @Param('tournamentId', ParseUUIDPipe) id: string,
    @Param('contestId', ParseUUIDPipe) contest: string,
    @Body() dto: ControlCommandDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.command(id, contest, dto, user);
  }
}
