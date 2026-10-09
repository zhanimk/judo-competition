import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.types.js';
import { CreateClubDto, RosterCommitDto, RosterPreviewDto } from './roster.dto.js';
import { RosterService } from './roster.service.js';

@Controller('tournaments')
export class RosterController {
  constructor(private readonly service: RosterService) {}
  @Get(':id/clubs') clubs(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    return this.service.clubs(id, user);
  }
  @Post(':id/clubs') createClub(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateClubDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.createClub(id, dto, user);
  }
  @Post(':id/roster/preview') preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RosterPreviewDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.preview(id, dto, user);
  }
  @Post(':id/roster') commit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RosterCommitDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.commit(id, dto, user);
  }
}
