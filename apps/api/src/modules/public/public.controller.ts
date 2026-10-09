import { Controller, Get, Param, ParseUUIDPipe, Header } from '@nestjs/common';
import { Public } from '../auth/auth.guard.js';
import { PublicService } from './public.service.js';
@Public()
@Controller('public/tournaments')
export class PublicController {
  constructor(private readonly service: PublicService) {}
  @Get() @Header('Cache-Control', 'no-store') list() {
    return this.service.list();
  }
  @Get(':id') @Header('Cache-Control', 'no-store') get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }
}
